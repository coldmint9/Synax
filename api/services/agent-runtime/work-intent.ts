/** Transport resumes and explicit bare continuations do not start a new objective. */
export function isWorkContinuation(text: string): boolean {
  return /^(?:继续(?:执行|吧)?|接着|resume|continue)[。.!！\s]*$/i.test(text.trim());
}
