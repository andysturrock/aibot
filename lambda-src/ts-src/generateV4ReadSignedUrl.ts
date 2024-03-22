
import {Storage, GetSignedUrlConfig} from '@google-cloud/storage';

export async function generateV4ReadSignedUrl(bucketName: string, fileName: string) {
  // Rather annoyingly Google seems to only get config from the filesystem.
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "./clientLibraryConfig.json";

  // Creates a client
  const storage = new Storage({
    projectId: "workload-identity-pools-416616"
  });

  // These options will allow temporary read access to the file
  const options: GetSignedUrlConfig = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
  };

  // Get a v4 signed URL for reading the file
  const file = storage.bucket(bucketName).file(fileName);
  const [signedUrl] = await file.getSignedUrl(options);

  return signedUrl;
}
