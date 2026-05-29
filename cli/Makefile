.PHONY: build run dev clean test lint fmt tidy

PROJECT_NAME := evercli
OUTPUT_DIR := _output
MAIN_PKG := .

BUILD_DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION    := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")

LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(GIT_COMMIT) -X main.date=$(BUILD_DATE)

build:
	@mkdir -p $(OUTPUT_DIR)
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o $(OUTPUT_DIR)/$(PROJECT_NAME) $(MAIN_PKG)
	@echo "Build complete: $(OUTPUT_DIR)/$(PROJECT_NAME)"

run: build
	$(OUTPUT_DIR)/$(PROJECT_NAME) $(ARGS)

dev:
	go run $(MAIN_PKG) $(ARGS)

clean:
	rm -rf $(OUTPUT_DIR)

test:
	go test ./... -count=1

test-v:
	go test ./... -v -count=1

lint:
	golangci-lint run ./...

fmt:
	go fmt ./...
	@command -v goimports >/dev/null && goimports -w . || true

tidy:
	go mod tidy
