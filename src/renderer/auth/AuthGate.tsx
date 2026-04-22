import React, { useCallback, useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useAuth } from "./AuthContext";
import { AuthScreen } from "./AuthScreen";
import { EntryScreen } from "./EntryScreen";
import { ElectronRunModeGreet } from "./ElectronRunModeGreet";
import { ElectronAppPinLock, ElectronAppPinOffer } from "./ElectronAppPinOverlays";
import { ElectronSyncAuthPanel } from "./ElectronSyncAuthPanel";
import { MustChangePasswordScreen } from "./MustChangePasswordScreen";
import {
  isElectronAppPinEnabled,
  isPinOfferDismissed,
  isSessionPinUnlocked,
} from "./electron-app-pin-storage";
import { isElectronUserAgent } from "../archon-web-shim";
import { isElectronCloudWpnSession } from "./electron-cloud-session";
import { isWebScratchSession } from "./web-scratch";
import { cloudLogoutThunk } from "../store/cloudAuthSlice";
import type { AppDispatch, RootState } from "../store";

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const {
    state,
    electronRunMode,
    chooseElectronRunMode,
    webAuthOverlay,
    closeWebAuth,
    electronSyncOverlay,
    closeElectronSyncAuth,
    openElectronSyncAuth,
    exitElectronSessionToWelcome,
  } = useAuth();
  const dispatch = useDispatch<AppDispatch>();
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [showPinOffer, setShowPinOffer] = useState(false);
  const [pinGateTick, setPinGateTick] = useState(0);

  const handleSignInWithEmailFromPin = useCallback(async () => {
    await dispatch(cloudLogoutThunk());
    openElectronSyncAuth("login");
    setPinGateTick((n) => n + 1);
  }, [dispatch, openElectronSyncAuth]);

  useEffect(() => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    if (electronRunMode !== "cloud") {
      setShowPinOffer(false);
      return;
    }
    if (electronSyncOverlay) {
      setShowPinOffer(false);
      return;
    }
    if (cloudAuth.busy || cloudAuth.status !== "signedIn") {
      if (cloudAuth.status !== "signedIn") {
        setShowPinOffer(false);
      }
      return;
    }
    if (isElectronAppPinEnabled() || isPinOfferDismissed()) {
      setShowPinOffer(false);
      return;
    }
    setShowPinOffer(true);
  }, [electronRunMode, electronSyncOverlay, cloudAuth.busy, cloudAuth.status]);

  useEffect(() => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    if (electronRunMode !== "cloud") {
      return;
    }
    if (cloudAuth.status !== "signedOut" || cloudAuth.busy) {
      return;
    }
    if (electronSyncOverlay !== null) {
      return;
    }
    openElectronSyncAuth("login");
  }, [
    cloudAuth.busy,
    cloudAuth.status,
    electronRunMode,
    electronSyncOverlay,
    openElectronSyncAuth,
  ]);

  /**
   * Block everything once the account is signed in with an admin-issued temp password.
   * Placed ahead of Electron/web branches so it applies uniformly; the only earlier
   * gates are run-mode greet + sync-only sign-in, which precede signedIn.
   */
  if (cloudAuth.status === "signedIn" && cloudAuth.mustSetPassword) {
    return <MustChangePasswordScreen />;
  }

  if (typeof window !== "undefined" && isElectronUserAgent()) {
    if (electronRunMode === "unset") {
      return <ElectronRunModeGreet onChoose={chooseElectronRunMode} />;
    }
    if (electronRunMode === "scratch" || electronRunMode === "local" || electronRunMode === "cloud") {
      const showPinLock =
        electronRunMode === "cloud" &&
        !electronSyncOverlay &&
        cloudAuth.status === "signedIn" &&
        !cloudAuth.busy &&
        isElectronAppPinEnabled() &&
        !isSessionPinUnlocked();

      const showPinOfferOverlay =
        electronRunMode === "cloud" &&
        !electronSyncOverlay &&
        cloudAuth.status === "signedIn" &&
        !cloudAuth.busy &&
        showPinOffer;

      return (
        <>
          {children}
          {electronSyncOverlay ? (
            <div className="fixed inset-0 z-[100] overflow-y-auto bg-background/90 backdrop-blur-sm">
              <div className="flex min-h-full items-center justify-center px-4 py-8">
                <ElectronSyncAuthPanel
                  initialMode={electronSyncOverlay}
                  onBack={
                    isElectronCloudWpnSession() ? exitElectronSessionToWelcome : closeElectronSyncAuth
                  }
                  backLabel={isElectronCloudWpnSession() ? "Return to home" : "Back"}
                  onSignedIn={closeElectronSyncAuth}
                />
              </div>
            </div>
          ) : null}
          {showPinLock ? (
            <ElectronAppPinLock
              key={`pin-lock-${pinGateTick}`}
              onUnlocked={() => setPinGateTick((n) => n + 1)}
              onSignInWithEmail={handleSignInWithEmailFromPin}
            />
          ) : null}
          {showPinOfferOverlay && !showPinLock ? (
            <ElectronAppPinOffer
              onSkip={() => setShowPinOffer(false)}
              onPinCreated={() => setShowPinOffer(false)}
            />
          ) : null}
        </>
      );
    }
    return <>{children}</>;
  }

  if (state.status === "authed") {
    return <>{children}</>;
  }

  if (
    typeof window !== "undefined" &&
    !isElectronUserAgent() &&
    webAuthOverlay
  ) {
    return (
      <AuthScreen initialMode={webAuthOverlay} onBack={closeWebAuth} />
    );
  }

  if (
    typeof window !== "undefined" &&
    !isElectronUserAgent() &&
    state.status === "anon" &&
    isWebScratchSession()
  ) {
    return <>{children}</>;
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-screen min-h-0 w-full items-center justify-center bg-background text-[12px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <EntryScreen />;
}
