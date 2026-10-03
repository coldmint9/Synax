export class GitMrError extends Error {
  constructor(
    message: string,
    public code = "GIT_MR_ERROR",
    public status = 409,
  ) {
    super(message);
  }
}
