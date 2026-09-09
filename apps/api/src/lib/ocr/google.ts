import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Storage } from '@google-cloud/storage';

import { getEnvVar } from '../utils/environment';

const googleCredentials = {
  type: 'service_account',
  private_key: getEnvVar('GOOGLE_PRIVATE_KEY', { devDefault: 'test' }),
  client_email: getEnvVar('GOOGLE_CLIENT_EMAIL', { devDefault: 'test' }),
  client_id: getEnvVar('GOOGLE_CLIENT_ID', { devDefault: 'test' }),
};

const googleOcrClient = new DocumentProcessorServiceClient({
  apiEndpoint: 'eu-documentai.googleapis.com',
  credentials: googleCredentials,
});

const googleStorageClient = new Storage({ credentials: googleCredentials });

function getProcessorName() {
  const projectId = getEnvVar('GOOGLE_PROJECT_ID');
  const location = getEnvVar('GOOGLE_PROJECT_LOCATION');
  const processorId = getEnvVar('GOOGLE_OCR_PROCESSOR_ID');
  return `projects/${projectId}/locations/${location}/processors/${processorId}`;
}

export { googleOcrClient, googleStorageClient, getProcessorName };
