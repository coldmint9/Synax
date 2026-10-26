import { memo, useState } from "react";
import { Paperclip } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import {
  Dialog, DialogBody, DialogCloseButton, DialogContainer,
  DialogHeader, DialogPanel, DialogTitle,
} from "../../shared/ui/ui/Dialog";

export const TextAttachmentCard = memo(function TextAttachmentCard({
  name,
  text,
}: {
  name: string;
  text: string;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${zh ? "查看原文" : "View original text"}: ${name}`}
        onClick={() => setOpened(true)}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl border border-primary/15 bg-primary/[0.08] px-3.5 py-2.5 text-left text-sm hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Paperclip size={16} aria-hidden="true" className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-primary" title={name}>{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {text.length.toLocaleString(locale)} {zh ? "字符" : "chars"}
        </span>
      </button>
      {opened ? (
        <Dialog open onClose={() => setOpened(false)}>
          <DialogContainer size="lg">
            <DialogPanel>
              <DialogHeader><DialogTitle className="break-all">{name}</DialogTitle></DialogHeader>
              <DialogCloseButton aria-label={zh ? "关闭" : "Close"} onClick={() => setOpened(false)} />
              <DialogBody>
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-surface/70 p-3 text-xs leading-5">{text}</pre>
              </DialogBody>
            </DialogPanel>
          </DialogContainer>
        </Dialog>
      ) : null}
    </>
  );
});
