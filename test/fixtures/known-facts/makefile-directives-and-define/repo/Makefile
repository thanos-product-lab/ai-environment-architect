include common.mk
-include local.mk
vpath %.h include:src
define HELP_TEXT
usage: make build
endef
# docs: generated
 spaced: x
ifeq ($(OS),Windows_NT)
win: ; echo win
endif
exporter: build
	@echo exporting
build:
	@echo building
