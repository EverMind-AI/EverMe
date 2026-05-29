.PHONY: dist dist-clean

VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")
DIST_DIR := dist
STAGE := $(DIST_DIR)/everme-$(VERSION)
ARCHIVE := $(DIST_DIR)/everme-$(VERSION).tar.gz

# Pack the working tree (so untracked dirs like cli/ are included),
# excluding .git/, __MACOSX/, node_modules/, and our own dist/ output.
dist:
	@mkdir -p $(DIST_DIR)
	@rm -rf $(STAGE)
	rsync -a \
	  --exclude='.git/' \
	  --exclude='__MACOSX/' \
	  --exclude='node_modules/' \
	  --exclude='.DS_Store' \
	  --exclude='/dist/' \
	  ./ $(STAGE)/
	tar -czf $(ARCHIVE) -C $(DIST_DIR) everme-$(VERSION)
	@rm -rf $(STAGE)
	@echo "Wrote $(ARCHIVE)"

dist-clean:
	rm -rf $(DIST_DIR)
