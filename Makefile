GO ?= go
BIN := lair

.PHONY: all build test test-race fmt vet clean

all: test build

build:
	$(GO) build -o $(BIN) ./cmd/lair

test:
	$(GO) test ./...

test-race:
	$(GO) test -race ./...

fmt:
	$(GO) fmt ./...

vet:
	$(GO) vet ./...

clean:
	rm -f $(BIN)
