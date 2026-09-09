"use client";

/**
 * Follow-along — the borrowed steering wheel.
 *
 * When armed for the active conversation, the UI auto-pilots itself to
 * wherever the agent is working (Phase A: it navigates to a movement the
 * moment the agent saves it). This hook owns that state and the navigation;
 * it reads the agent's event stream only indirectly, via
 * `navigateOnSavedMovement` which the chat subscription calls.
 *
 * Principles (plans/2026-06-16-follow-along):
 *  - Observation, never control — it only navigates; it never changes what
 *    the agent does.
 *  - The user is always in control — a manual route change while armed
 *    pauses following (we don't yank the page from someone who just
 *    clicked); the toggle re-arms and resumes.
 *  - Per-(tab, conversation), persisted in sessionStorage (see
 *    follow-storage). Default-on is seeded only by the setup hand-off.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

import { readFollowArmed, writeFollowArmed } from "./follow-storage";

export interface FollowController {
  /** Armed AND not paused — i.e. a saved movement will whisk the user there. */
  followActive: boolean;
  /** Armed but suspended because the user navigated manually. */
  followPaused: boolean;
  /** Whether following can be engaged at all (there's an active conversation). */
  canFollow: boolean;
  /** Toggle following for the active conversation (also resumes from pause). */
  toggleFollow: () => void;
  /** Called by the chat subscription when the agent saves a movement. */
  navigateOnSavedMovement: (movementId: string) => void;
  /**
   * Arm the next/active conversation by default (the setup hand-off). Pass a
   * conversation id to arm it now, or nothing to arm whichever conversation
   * becomes active next (a fresh conversation created from a seeded message).
   */
  seedFollowDefault: (conversationId?: string | null) => void;
  /**
   * Will this turn be followed? True when following is active OR a follow
   * default is pending — the latter matters on the FIRST turn of a fresh
   * conversation, where the conversation (and thus `armed`) doesn't exist yet
   * at send time but the user already opted in via setup. Read imperatively.
   */
  followIntent: () => boolean;
}

export function useFollowController(
  activeConversationId: string | null,
): FollowController {
  const router = useRouter();
  const pathname = usePathname();

  const [armed, setArmed] = useState(false);
  const [paused, setPaused] = useState(false);
  const pendingDefaultRef = useRef(false);
  const selfNavRef = useRef(false);
  const lastPathRef = useRef<string | null>(null);

  // Load arm state when the active conversation changes; honour a pending
  // "default on" the moment a conversation (e.g. a fresh one seeded by setup)
  // exists. A conversation switch always clears a transient pause.
  useEffect(() => {
    setPaused(false);
    if (!activeConversationId) {
      setArmed(false);
      return;
    }
    if (pendingDefaultRef.current) {
      pendingDefaultRef.current = false;
      writeFollowArmed(activeConversationId, true);
      setArmed(true);
      return;
    }
    setArmed(readFollowArmed(activeConversationId));
  }, [activeConversationId]);

  // A manual route change while armed pauses following. Our own follow-driven
  // push sets selfNavRef so it doesn't pause itself.
  useEffect(() => {
    if (lastPathRef.current === null) {
      lastPathRef.current = pathname;
      return;
    }
    if (pathname === lastPathRef.current) return;
    lastPathRef.current = pathname;
    if (selfNavRef.current) {
      selfNavRef.current = false;
      return;
    }
    setPaused(true);
  }, [pathname]);

  const active = armed && !paused;
  // The subscription callback is stable but must see the live values.
  const activeRef = useRef(active);
  activeRef.current = active;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const toggleFollow = useCallback(() => {
    if (!activeConversationId) return;
    if (activeRef.current) {
      writeFollowArmed(activeConversationId, false);
      setArmed(false);
    } else {
      writeFollowArmed(activeConversationId, true);
      setArmed(true);
      setPaused(false);
    }
  }, [activeConversationId]);

  const navigateOnSavedMovement = useCallback(
    (movementId: string) => {
      if (!activeRef.current) return;
      const target = `/movements/${movementId}`;
      // Progressive authoring re-saves the same movement repeatedly; only the
      // first lands us on the page. Once there, the page itself fills in live.
      if (pathnameRef.current === target) return;
      selfNavRef.current = true;
      router.push(target);
    },
    [router],
  );

  const seedFollowDefault = useCallback((conversationId?: string | null) => {
    if (conversationId) {
      writeFollowArmed(conversationId, true);
      setArmed(true);
      setPaused(false);
    } else {
      pendingDefaultRef.current = true;
    }
  }, []);

  const followIntent = useCallback(
    () => activeRef.current || pendingDefaultRef.current,
    [],
  );

  return {
    followActive: active,
    followPaused: paused,
    canFollow: !!activeConversationId,
    toggleFollow,
    navigateOnSavedMovement,
    seedFollowDefault,
    followIntent,
  };
}
