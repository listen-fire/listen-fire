import { register as registerFolder, DROPBOX_FOLDER_NODE_TYPE } from './folder';
import { register as registerDocument, DROPBOX_DOCUMENT_NODE_TYPE } from './document';
import { register as registerUpload, DROPBOX_UPLOAD_NODE_TYPE } from './upload';

export { DROPBOX_FOLDER_NODE_TYPE, folderConfigSchema } from './folder';
export type { DropboxFolderConfig } from './folder';
export { DROPBOX_DOCUMENT_NODE_TYPE, documentConfigSchema } from './document';
export type { DropboxDocumentConfig } from './document';
export { DROPBOX_UPLOAD_NODE_TYPE, uploadConfigSchema } from './upload';
export type { DropboxUploadConfig } from './upload';

export function registerDropboxNodeTypes(): void {
  registerFolder({
    document: DROPBOX_DOCUMENT_NODE_TYPE,
    upload: DROPBOX_UPLOAD_NODE_TYPE,
  });
  registerDocument();
  registerUpload();
}
