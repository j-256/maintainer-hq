import { z } from "zod";
import { GITHUB_APP_LIMITS } from "./github-apps";

export const githubAppPrivateInputSchema = z
  .object({
    version: z.literal(1),
    privateKey: z.string().min(1).max(GITHUB_APP_LIMITS.PRIVATE_INPUT_BYTES),
    webhookSecret: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type GitHubAppPrivateInput = z.infer<typeof githubAppPrivateInputSchema>;
