#!/bin/bash
# Stands in for npx (LF_RELEASE_NPX) in the headless sign-in test: prints what
# `npm login` prints with no terminal (title, then the URL on its own line).
[ "$3" = "whoami" ] && exit 1
echo "npm warn exec The following package was not found and will be installed: npm@11.21.2"
echo "Login at:"
echo "https://www.npmjs.com/login?next=/login/cli/00000000-test"
echo "Logged in on https://registry.npmjs.org/."
