UUID = stage-manager@gnome-stage-manager
VERSION = 1.4.0
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR = src
SCHEMAS_DIR = $(SRC_DIR)/schemas
DIST_DIR = dist
PACK_FILE = $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: all build install uninstall clean schemas pack lint restart test pot

all: build

# Compile GSettings schemas
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

# Build the extension (compile schemas)
build: schemas

# Install to local GNOME Shell extensions directory
install: build
	@mkdir -p $(EXTENSION_DIR)
	@cp -r $(SRC_DIR)/* $(EXTENSION_DIR)/
	@echo "Extension installed to $(EXTENSION_DIR)"
	@echo "Restart GNOME Shell (Alt+F2, 'r', Enter on X11) or log out/in on Wayland."

# Uninstall the extension
uninstall:
	@rm -rf $(EXTENSION_DIR)
	@echo "Extension uninstalled."

# Create a distributable zip for GNOME Extensions Store (extensions.gnome.org).
# NOTE: per EGO-P-006, compiled schemas MUST NOT be shipped for shell-version
# 45+ — GNOME Shell compiles them at install time. The pack target therefore
# does NOT depend on `build`, and excludes any *.compiled files defensively.
pack:
	@mkdir -p $(DIST_DIR)
	@rm -f $(PACK_FILE)
	@cd $(SRC_DIR) && zip -r ../$(PACK_FILE) . \
		-x "__pycache__/*" "schemas/*.compiled" "*.compiled"
	@# The zip is a binary distribution of GPL source, so it carries its licence.
	@zip -q -j $(PACK_FILE) LICENSE
	@echo "Extension packed: $(PACK_FILE)"

# Clean build artifacts
clean:
	@rm -rf $(DIST_DIR)
	@rm -f $(SCHEMAS_DIR)/*.compiled

# Run the offline logic tests (see tests/README.md). Needs node.
test:
	@if command -v node >/dev/null 2>&1; then \
		node tests/build.mjs >/dev/null && node tests/run.mjs; \
	else \
		echo "node not found — skipping tests (see tests/README.md)"; \
	fi

# Regenerate the translation template from the sources.
pot:
	@xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=ngettext:1,2 \
		--package-name="Stage Manager" --package-version=$(VERSION) \
		--copyright-holder="Stage Manager contributors" \
		--msgid-bugs-address="https://github.com/itsdigvijaysing/gnome-stage-manager/issues" \
		-o po/stage-manager.pot $(SRC_DIR)/extension.js $(SRC_DIR)/prefs.js
	@xgettext --from-code=UTF-8 --join-existing --omit-header \
		-o po/stage-manager.pot $(SCHEMAS_DIR)/*.gschema.xml
	@echo "Template updated: po/stage-manager.pot"

# Lint JavaScript files with eslint (if available)
lint:
	@if command -v eslint >/dev/null 2>&1; then \
		eslint $(SRC_DIR)/*.js; \
	else \
		echo "eslint not found. Install with: npm install -g eslint"; \
	fi

# Restart GNOME Shell (X11 only)
restart:
	@if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'; \
	else \
		echo "On Wayland, please log out and log back in to reload extensions."; \
	fi

# Build .deb package
deb: build
	dpkg-buildpackage -us -uc -b
	@echo "Debian package built in parent directory."
