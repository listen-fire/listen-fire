import { register as registerFolder, GDRIVE_FOLDER_NODE_TYPE } from './folder';
import { register as registerDocument, GDRIVE_DOCUMENT_NODE_TYPE } from './document';
import { register as registerUpload, GDRIVE_UPLOAD_NODE_TYPE } from './upload';

export { GDRIVE_FOLDER_NODE_TYPE, folderConfigSchema } from './folder';
export type { GDriveFolderConfig } from './folder';
export { GDRIVE_DOCUMENT_NODE_TYPE, documentConfigSchema } from './document';
export type { GDriveDocumentConfig } from './document';
export { GDRIVE_UPLOAD_NODE_TYPE, uploadConfigSchema } from './upload';
export type { GDriveUploadConfig } from './upload';

export function registerGDriveNodeTypes(): void {
  registerFolder({
    document: GDRIVE_DOCUMENT_NODE_TYPE,
    upload: GDRIVE_UPLOAD_NODE_TYPE,
  });
  registerDocument();
  registerUpload();
}
