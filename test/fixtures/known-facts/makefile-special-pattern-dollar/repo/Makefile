.PHONY: all clean docs
.DEFAULT_GOAL := all
all: app
%.o: %.c
	cc -c $<
$(BIN): main.o
app-$(VERSION).tar: app
out/%.txt docs: src
clean:
	rm -f *.o
