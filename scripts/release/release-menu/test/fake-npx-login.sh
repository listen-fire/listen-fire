#!/bin/bash
# Stands in for npx (LF_RELEASE_NPX) in the headless sign-in test: prints what
# `npm login` 11.21.2 prints with no terminal: notices that carry other URLs,
# then the title, then the sign-in URL on its own line.
[ "$3" = "whoami" ] && exit 1
echo "npm warn exec The following package was not found and will be installed: npm@11.21.2"
echo "npm notice Log in on https://registry.npmjs.org/"
echo "npm notice npm tokens that bypass 2FA are being restricted. Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation"
echo "Login at:"
echo "https://www.npmjs.com/login?next=/login/cli/00000000-test"
echo "Logged in on https://registry.npmjs.org/."
