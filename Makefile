UUID = stage-manager@gnome-stage-manager
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR = src
SCHEMAS_DIR = $(SRC_DIR)/schemas
DIST_DIR = dist
PACK_FILE = $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: all build install uninstall clean schemas pack lint restart

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

# Create a distributable zip for GNOME Extensions Store
# NOTE: compiled schemas MUST be included — GNOME Shell loads them at runtime
pack: build
	@mkdir -p $(DIST_DIR)
	@cd $(SRC_DIR) && zip -r ../$(PACK_FILE) . \
		-x "__pycache__/*"
	@echo "Extension packed: $(PACK_FILE)"

# Clean build artifacts
clean:
	@rm -rf $(DIST_DIR)
	@rm -f $(SCHEMAS_DIR)/*.compiled

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
