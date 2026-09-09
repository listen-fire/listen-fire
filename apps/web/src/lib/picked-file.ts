// Files a person attaches in the browser, carried to the server as base64 —
// the shape every "run this with some input" affordance sends.

/** A file the user has picked, with its bytes read as base64 for upload. */
export interface PickedFile {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
}

/** Read a browser File into the base64 payload the run mutations expect. */
export function readFileAsBase64(file: File): Promise<PickedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => {
      // `result` is a data URL: "data:<mime>;base64,<data>". Strip the prefix.
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        contentBase64: comma >= 0 ? result.slice(comma + 1) : result,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}
