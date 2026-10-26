"use client";

import { createContext } from "react";
import { getVerificationGuide } from "@/lib/api";
import type { VerificationGuide } from "@/lib/verification-guide";

export type { VerificationGuide };

/**
 * Where the verification materials come from: the live coordinator by
 * default, or a fixed record such as the walkthrough's rehearsal snapshot.
 */
export const VerificationGuideSource = createContext<() => Promise<VerificationGuide>>(getVerificationGuide);
