// Package dns implements the tiny local DNS server Lair uses for *.test.
//
// It speaks just enough DNS on UDP: it parses the question section, answers
// A/AAAA for the configured development domain with loopback addresses, and
// forwards every other query to upstream resolvers. It is deliberately small
// and dependency-free; it is not a general-purpose recursive resolver.
package dns

import (
	"encoding/binary"
	"fmt"
	"strings"
)

const (
	typeA    = 1
	typeAAAA = 28
	classIN  = 1

	// Pointer to the first question name (offset 12 in a standard message).
	questionNamePointer = 0xc00c
)

// Question is a parsed DNS question.
type Question struct {
	Name  string // canonical, lower-case, trailing dot
	Type  uint16
	Class uint16
}

// ParseQuestion extracts the first question from a DNS query.
func ParseQuestion(msg []byte) (Question, error) {
	if len(msg) < 12 {
		return Question{}, fmt.Errorf("DNS message too short")
	}
	qd := binary.BigEndian.Uint16(msg[4:6])
	if qd == 0 {
		return Question{}, fmt.Errorf("DNS message has no question")
	}
	name, end, err := readName(msg, 12)
	if err != nil {
		return Question{}, err
	}
	if end+4 > len(msg) {
		return Question{}, fmt.Errorf("truncated question")
	}
	return Question{
		Name:  strings.ToLower(name),
		Type:  binary.BigEndian.Uint16(msg[end : end+2]),
		Class: binary.BigEndian.Uint16(msg[end+2 : end+4]),
	}, nil
}

// readName decodes a possibly-compressed domain name. It returns the decoded
// name and the offset just after the name in the original message.
func readName(msg []byte, offset int) (string, int, error) {
	var parts []string
	seen := map[int]bool{}
	pos := offset
	end := -1
	for {
		if pos >= len(msg) {
			return "", 0, fmt.Errorf("truncated name")
		}
		lenByte := int(msg[pos])
		if lenByte&0xc0 == 0xc0 { // compression pointer
			if pos+1 >= len(msg) {
				return "", 0, fmt.Errorf("truncated pointer")
			}
			ptr := int(binary.BigEndian.Uint16(msg[pos:pos+2]) & 0x3fff)
			if seen[ptr] {
				return "", 0, fmt.Errorf("compression loop")
			}
			seen[ptr] = true
			sub, _, err := readName(msg, ptr)
			if err != nil {
				return "", 0, err
			}
			parts = append(parts, sub)
			if end < 0 {
				end = pos + 2
			}
			break
		}
		if lenByte == 0 { // root label
			pos++
			if end < 0 {
				end = pos
			}
			break
		}
		if pos+1+lenByte > len(msg) {
			return "", 0, fmt.Errorf("label out of bounds")
		}
		parts = append(parts, string(msg[pos+1:pos+1+lenByte]))
		pos += 1 + lenByte
	}
	name := strings.Join(parts, ".")
	if name != "" {
		name += "."
	}
	return name, end, nil
}

// ResourceRecord is one answer to append to a response.
type ResourceRecord struct {
	Type uint16
	TTL  uint32
	Data []byte // already in wire format (4 bytes for A, 16 for AAAA)
}

// ARecord builds an A answer.
func ARecord(ip [4]byte, ttl uint32) ResourceRecord {
	return ResourceRecord{Type: typeA, TTL: ttl, Data: append([]byte(nil), ip[:]...)}
}

// AAAARecord builds an AAAA answer.
func AAAARecord(ip [16]byte, ttl uint32) ResourceRecord {
	return ResourceRecord{Type: typeAAAA, TTL: ttl, Data: append([]byte(nil), ip[:]...)}
}

// BuildResponse turns a query into a response carrying the given answers for
// the question name. The question section is copied verbatim; answer names
// use a compression pointer to it.
func BuildResponse(query []byte, answers ...ResourceRecord) ([]byte, error) {
	q, err := ParseQuestion(query)
	if err != nil {
		return nil, err
	}
	// Find the end of the question section.
	_, qEnd, err := readName(query, 12)
	if err != nil {
		return nil, err
	}
	qEnd += 4 // qtype + qclass
	if qEnd > len(query) {
		return nil, fmt.Errorf("truncated question")
	}
	question := append([]byte(nil), query[12:qEnd]...)

	resp := make([]byte, 12, 12+len(question)+len(answers)*16)
	copy(resp, query[:12])
	// QR=1, AA=1, RA=1; preserve the ID.
	binary.BigEndian.PutUint16(resp[2:4], 0x8400|0x0080)
	binary.BigEndian.PutUint16(resp[4:6], 1) // QDCOUNT
	binary.BigEndian.PutUint16(resp[6:8], uint16(len(answers)))
	binary.BigEndian.PutUint16(resp[8:10], 0)
	binary.BigEndian.PutUint16(resp[10:12], 0)
	resp = append(resp, question...)

	for _, a := range answers {
		// RR header: NAME(2) TYPE(2) CLASS(2) TTL(4) RDLENGTH(2) = 12 bytes.
		rr := make([]byte, 12, 12+len(a.Data))
		binary.BigEndian.PutUint16(rr[0:2], questionNamePointer)
		binary.BigEndian.PutUint16(rr[2:4], a.Type)
		binary.BigEndian.PutUint16(rr[4:6], classIN)
		binary.BigEndian.PutUint32(rr[6:10], a.TTL)
		binary.BigEndian.PutUint16(rr[10:12], uint16(len(a.Data)))
		rr = append(rr, a.Data...)
		resp = append(resp, rr...)
	}
	_ = q
	return resp, nil
}

// BuildNXDomain returns a negative response for a query.
func BuildNXDomain(query []byte) ([]byte, error) {
	resp, err := BuildResponse(query)
	if err != nil {
		return nil, err
	}
	// RCODE = 3 (NXDOMAIN), keep QR/AA/RA bits.
	flags := binary.BigEndian.Uint16(resp[2:4])
	binary.BigEndian.PutUint16(resp[2:4], flags|3)
	return resp, nil
}
