import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { HealingContext, HealingSuggestion } from "./azure-openai-client";

// ---------------------------------------------------------------------------
// Proposal types
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface HealingProposal {
  proposalId: string;
  status: ProposalStatus;
  context: HealingContext;
  suggestion: HealingSuggestion;
  proposedAt: string;
  decidedAt?: string;
  decidedBy?: "auto-confidence" | "auto-env" | "manual";
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface HealingStore {
  /** Persist a new proposal with status "pending". */
  propose(context: HealingContext, suggestion: HealingSuggestion): HealingProposal;
  /** Mark a proposal as approved. */
  approve(proposalId: string, decidedBy: HealingProposal["decidedBy"]): HealingProposal;
  /** Mark a proposal as rejected. */
  reject(proposalId: string, decidedBy: HealingProposal["decidedBy"]): HealingProposal;
  /** Returns a previously approved selector for the same failing selector, or undefined. */
  getApproved(failedSelector: string): HealingProposal | undefined;
  /** Returns all proposals (all statuses). */
  list(): HealingProposal[];
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

const STORE_FILE_NAME = "healing-proposals.json";

interface StoreFile {
  proposals: HealingProposal[];
}

export class FileHealingStore implements HealingStore {
  private readonly storeFile: string;

  constructor(storeDir?: string) {
    const dir = storeDir ?? path.join(process.cwd(), "healing");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.storeFile = path.join(dir, STORE_FILE_NAME);
  }

  propose(context: HealingContext, suggestion: HealingSuggestion): HealingProposal {
    const proposal: HealingProposal = {
      proposalId: generateId(context.failedSelector),
      status: "pending",
      context,
      suggestion,
      proposedAt: new Date().toISOString(),
    };
    this.write([...this.read(), proposal]);
    return proposal;
  }

  approve(
    proposalId: string,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    return this.updateStatus(proposalId, "approved", decidedBy);
  }

  reject(
    proposalId: string,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    return this.updateStatus(proposalId, "rejected", decidedBy);
  }

  getApproved(failedSelector: string): HealingProposal | undefined {
    return this.read()
      .filter(
        (p) =>
          p.status === "approved" &&
          p.context.failedSelector === failedSelector,
      )
      .sort(
        (a, b) =>
          new Date(b.decidedAt ?? b.proposedAt).getTime() -
          new Date(a.decidedAt ?? a.proposedAt).getTime(),
      )[0];
  }

  list(): HealingProposal[] {
    return this.read();
  }

  // -------------------------------------------------------------------------

  private read(): HealingProposal[] {
    if (!fs.existsSync(this.storeFile)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.storeFile, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      return Array.isArray(parsed.proposals) ? parsed.proposals : [];
    } catch {
      return [];
    }
  }

  private write(proposals: HealingProposal[]): void {
    const file: StoreFile = { proposals };
    fs.writeFileSync(this.storeFile, JSON.stringify(file, null, 2), "utf8");
  }

  private updateStatus(
    proposalId: string,
    status: ProposalStatus,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    const proposals = this.read();
    const index = proposals.findIndex((p) => p.proposalId === proposalId);
    if (index === -1) {
      throw new Error(`HealingStore: proposal "${proposalId}" not found`);
    }
    const updated: HealingProposal = {
      ...proposals[index],
      status,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };
    proposals[index] = updated;
    this.write(proposals);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// In-memory store (for unit tests — no disk I/O)
// ---------------------------------------------------------------------------

export class InMemoryHealingStore implements HealingStore {
  private readonly proposals: HealingProposal[] = [];

  propose(context: HealingContext, suggestion: HealingSuggestion): HealingProposal {
    const proposal: HealingProposal = {
      proposalId: generateId(context.failedSelector),
      status: "pending",
      context,
      suggestion,
      proposedAt: new Date().toISOString(),
    };
    this.proposals.push(proposal);
    return proposal;
  }

  approve(
    proposalId: string,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    return this.mutate(proposalId, "approved", decidedBy);
  }

  reject(
    proposalId: string,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    return this.mutate(proposalId, "rejected", decidedBy);
  }

  getApproved(failedSelector: string): HealingProposal | undefined {
    return this.proposals.find(
      (p) =>
        p.status === "approved" && p.context.failedSelector === failedSelector,
    );
  }

  list(): HealingProposal[] {
    return [...this.proposals];
  }

  private mutate(
    proposalId: string,
    status: ProposalStatus,
    decidedBy: HealingProposal["decidedBy"],
  ): HealingProposal {
    const proposal = this.proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) {
      throw new Error(`InMemoryHealingStore: proposal "${proposalId}" not found`);
    }
    proposal.status = status;
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = decidedBy;
    return proposal;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateId(seed: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}::${Date.now()}`)
    .digest("hex")
    .slice(0, 12);
  return `heal-${hash}`;
}
