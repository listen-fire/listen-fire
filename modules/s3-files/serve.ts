#!/usr/bin/env node
// The process listen-fire starts for a files module (lf-external.yaml's `command`): it
// listens where listen-fire says (`MODULE_SOCKET`) and prints the `listening …` line
// listen-fire reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { S3_FILES_MANIFEST, s3FilesAnswer } from './s3_files';

void serveSlot({ manifest: S3_FILES_MANIFEST, answer: s3FilesAnswer(), print: true });
