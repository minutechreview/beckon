"use client";

import { useEffect, useState } from "react";
import { isIOS, isStandalone } from "@/lib/client/push";
import { Icon } from "./Icon";

/** The iOS Share symbol (a square with an arrow), drawn inline so the step matches what's on screen. */
function ShareGlyph() {
  return (
    <svg className="share-glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** "Install the app": the native prompt where the browser offers one, the Share-sheet steps on iOS. */
export function InstallPwa() {
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIOS());
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep it for our button
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return <p className="status-ok with-icon" data-testid="installed"><Icon name="check" size={18} strokeWidth={2.2} />Running as an installed app.</p>;
  if (ios) {
    return (
      <div data-testid="ios-install">
        <p>On iPhone and iPad, notifications only work from the installed app (iOS 16.4 or later):</p>
        <ol className="ios-steps">
          <li>Open this page in <strong>Safari</strong>.</li>
          <li>Tap <strong>Share</strong> <ShareGlyph /> in the toolbar.</li>
          <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
          <li>Open <strong>Beckon</strong> from your Home Screen and carry on there.</li>
        </ol>
      </div>
    );
  }
  if (prompt) {
    return (
      <button
        className="btn primary"
        data-testid="install-app"
        onClick={async () => {
          await prompt.prompt();
          await prompt.userChoice;
          setPrompt(null);
        }}
      >
        Install Beckon
      </button>
    );
  }
  return (
    <p className="note">
      Optional on desktop and Android: use your browser&apos;s menu → <strong>Install app</strong> (or <strong>Add to Home screen</strong>) for a
      standalone window and a Home Screen icon.
    </p>
  );
}
