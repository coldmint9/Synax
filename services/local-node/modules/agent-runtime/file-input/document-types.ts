export const OFFICE_DOCUMENT_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export function isVisualDocument(mediaType: string): boolean {
  return (
    mediaType === "application/pdf" ||
    Object.values(OFFICE_DOCUMENT_TYPES).includes(mediaType)
  );
}
