"use client";

import * as Sentry from "@sentry/nextjs";
import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

type SentryUser = Parameters<typeof Sentry.setUser>[0];

const safeSetSentryUser = (user: SentryUser) => {
  try {
    Sentry.setUser(user);
  } catch {
    // Silently fail if Sentry is not configured
  }
};

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/sign-out")
  );
};

/**
 * Auth pages that can be accessed regardless of login state.
 * - /auth/two-factor is used for both:
 *   1. 2FA verification during login (user not fully logged in yet)
 *   2. 2FA setup after enabling 2FA (user is logged in)
 * - /auth/sign-out must be accessible when logged in to perform sign-out
 */
const isSpecialAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/two-factor") ||
    pathname?.startsWith("/auth/sign-out")
  );
};

/**
 * Public pages accessible without authentication. The token in the URL is the
 * credential, so we must not redirect to sign-in even when no session exists.
 */
const isPublicPage = (pathname: string) => {
  return pathname?.startsWith("/chat/share/");
};

export const WithAuthCheck: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const router = useRouter();
  const pathname = usePathname();
  // useSearchParams is intentionally not used here to avoid the need
  // to wrap whole app in Suspense which causes flickering
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const [isMounted, setIsMounted] = useState(false);

  const {
    data: session,
    isPending: isAuthPending,
    isRefetching: isAuthRefetching,
  } = authClient.useSession();

  const isLoggedIn = session?.user;
  const isAuthPage = pathCorrespondsToAnAuthPage(pathname);
  const isSpecialAuth = isSpecialAuthPage(pathname);
  const isPublic = isPublicPage(pathname);

  // Track mount state to avoid hydration errors with isRefetching
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Only use isRefetching after mount to avoid SSR/client hydration mismatch
  // Before mount, treat as initializing to match SSR behavior
  const isAuthInitializing = isMounted
    ? isAuthPending && !isAuthRefetching // After mount: distinguish refetch from initial
    : isAuthPending; // During SSR/hydration: just check isPending

  const inProgress = isAuthInitializing;

  // Set Sentry user context when user is authenticated
  useEffect(() => {
    if (session?.user) {
      safeSetSentryUser({
        id: session.user.id,
        email: session.user.email,
        username: session.user.name || session.user.email,
      });
    } else {
      // Clear user context when not authenticated
      safeSetSentryUser(null);
    }
  }, [session?.user]);

  // Redirect to home if user is logged in and on auth page, or if user is not logged in and not on auth page
  useEffect(() => {
    if (isAuthInitializing || isAuthRefetching) {
      // If auth check is pending, don't do anything
      return;
    } else if (isSpecialAuth || isPublic) {
      // Special auth pages (like /auth/two-factor) and public token-gated pages
      // (like /chat/share/:token) bypass login redirects entirely.
      return;
    } else if (isAuthPage && isLoggedIn) {
      // User is logged in but on auth page (sign-in/sign-up), redirect to redirectTo or home
      const redirectTo = searchParams.get("redirectTo");
      router.push(getValidatedRedirectPath(redirectTo));
    } else if (!isAuthPage && !isLoggedIn) {
      // User is not logged in and not on any auth page, redirect to sign-in
      // Preserve the original URL (including query params) so we can redirect back after login
      const queryString = searchParams.toString();
      const fullPath = queryString ? `${pathname}?${queryString}` : pathname;
      const redirectTo = encodeURIComponent(fullPath);
      router.push(`/auth/sign-in?redirectTo=${redirectTo}`);
    }
  }, [
    isAuthInitializing,
    isAuthRefetching,
    isAuthPage,
    isLoggedIn,
    router,
    isSpecialAuth,
    isPublic,
    pathname,
    searchParams,
  ]);

  // Show loading while checking auth/permissions
  if (inProgress) {
    return null;
  } else if (isSpecialAuth || isPublic) {
    // Special auth pages and public token-gated pages always render.
    return <>{children}</>;
  } else if (isAuthPage && isLoggedIn) {
    // During redirects, show nothing to avoid flash
    return null;
  } else if (!isAuthPage && !isLoggedIn) {
    return null;
  }

  return <>{children}</>;
};
