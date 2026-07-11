OP_ACCOUNT ?= my.1password.com
OPENROUTER_API_KEY_OP_REF ?= op://Private/OpenRouterAPI/pi

# Fill .env.template via 1Password CLI (`op inject`) and write it to .env.
# Requires: `op signin` (or the 1Password app's CLI integration) beforehand.
# Override with:
#   make env OP_ACCOUNT=other.1password.com OPENROUTER_API_KEY_OP_REF=op://Vault/Item/field
.PHONY: env
env:
	sed 's|OPENROUTER_API_KEY_OP_REF|$(OPENROUTER_API_KEY_OP_REF)|' .env.template \
		| op inject --account=$(OP_ACCOUNT) -o .env

# Run pi with .env loaded, without polluting the calling shell.
# Usage: make pi ARGS="-e ./extensions/pi-hello --no-session"
.PHONY: pi
pi:
	set -a && . ./.env && set +a && pi $(ARGS)
