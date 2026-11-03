import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useId, useState } from "react";
import { type AskRequest, useAskStore } from "./lib/ask";

/**
 * Fork-only (SSH port): renders the dialogs requested through `askConfirm`
 * and `askText` (see lib/ask.ts for why native dialogs cannot be used).
 * Mounted once by the remotes panel.
 */
export function AskDialogHost() {
  const current = useAskStore((s) => s.current);
  if (!current) return null;
  return current.kind === "confirm" ? (
    <ConfirmDialog req={current} />
  ) : (
    <TextDialog req={current} />
  );
}

function ConfirmDialog({
  req,
}: {
  req: Extract<AskRequest, { kind: "confirm" }>;
}) {
  const settle = useAskStore((s) => s.settle);
  const answer = (ok: boolean) => {
    req.resolve(ok);
    settle();
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{req.title}</AlertDialogTitle>
          {req.description ? (
            <AlertDialogDescription>{req.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant={req.destructive ? "destructive" : "default"}
            onClick={() => answer(true)}
          >
            {req.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TextDialog({ req }: { req: Extract<AskRequest, { kind: "text" }> }) {
  const settle = useAskStore((s) => s.settle);
  const [value, setValue] = useState(req.initial);
  const [touched, setTouched] = useState(false);
  const id = useId();
  useEffect(() => {
    setValue(req.initial);
    setTouched(false);
  }, [req]);

  const problem = req.validate?.(value) ?? null;
  const finish = (result: string | null) => {
    req.resolve(result);
    settle();
  };
  const submit = () => {
    setTouched(true);
    if (problem) return;
    finish(value.trim());
  };

  return (
    <Dialog open onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{req.title}</DialogTitle>
            {req.description ? (
              <DialogDescription>{req.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={id}>{req.label}</Label>
            <Input
              id={id}
              autoFocus
              value={value}
              spellCheck={false}
              aria-invalid={touched && !!problem}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
            {touched && problem ? (
              <p role="alert" className="text-[11.5px] text-destructive">
                {problem}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{req.confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
