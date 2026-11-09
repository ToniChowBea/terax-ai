# Personal Terax fork helpers. Run `make` to list targets.

APP := Terax.app
BUNDLE_DIR := src-tauri/target/release/bundle/macos

.PHONY: help update update-abort verify build install weekly

help:
	@echo "make update        merge latest upstream main into your branch, then run checks"
	@echo "make update-abort  cancel a merge that hit conflicts"
	@echo "make verify        install deps, type-check, lint, test, cargo check"
	@echo "make build         build $(APP)"
	@echo "make install       build, copy to /Applications, clear quarantine"
	@echo "make weekly        update + install in one go"

update:
	@bash scripts/fork-update.sh

update-abort:
	git merge --abort

verify:
	pnpm install
	pnpm check-types
	pnpm lint
	pnpm test
	cd src-tauri && cargo check --locked --all-targets

build:
	pnpm install
	pnpm tauri build --bundles app --ignore-version-mismatches

# A running Terax keeps its old code until it is quit. It is not killed here:
# this usually runs in a Terax terminal, so that would end make and every shell.
# -a because pgrep otherwise skips its own ancestors, which Terax then is.
install: build
	rm -rf /Applications/$(APP)
	cp -R $(BUNDLE_DIR)/$(APP) /Applications/
	xattr -dr com.apple.quarantine /Applications/$(APP) || true
	@echo "Installed /Applications/$(APP)"
	@pgrep -ax terax >/dev/null && echo "Terax is still running the old build: quit it (Cmd+Q) and reopen to update." || true

weekly: update install
