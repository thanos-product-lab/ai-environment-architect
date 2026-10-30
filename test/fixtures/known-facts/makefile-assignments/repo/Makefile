CC := gcc
PREFIX ::= /usr/local
IMM :::= now
FLAGS = -O2 -DMODE=fast:yes
VERSION ?= 1.0
lint:= eslint
fmt::= prettier
build: main.o
	$(CC) -o app main.o
test:
	./run-tests
deploy: ; echo deploy
check: VERBOSE=1
