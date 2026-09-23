import { describe, it, expect, afterEach } from "vitest";
import { ReplayEngine } from "./replay-engine.js";
import { MockSurface } from "../surface/mock-surface.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import type { CapabilityArtifact, AllowlistConfig } from "../artifact/types.js";
import { rmSync } from "fs";
import path from "path";

const TEST_EVIDENCE_DIR = path.join(process.cwd(), "test-evidence-replay");

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/search*", "/detail*", "/"],
  permittedActions: ["navigate", "click", "type", "extract", "wait", "submit"],
};

function mockArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    artifactVersion: 1,
    capability: "lookup-member-balance",
    description: "Look up member and read balance",
    surface: { type: "web", baseUrl: "http://localhost:3000" },
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "memberName", type: "string" }],
    allowlist,
    steps: [
      {
        id: 1,
        action: "navigate",
        target: { primary: { role: "RootWebArea", name: "http://localhost:3000/search" } },
        value: "http://localhost:3000/search",
      },
      {
        id: 2,
        action: "type",
        target: { primary: { role: "textbox", name: "Member ID" } },
        value: "{{memberId}}",
        guard: { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] },
        checkpoint: { anyOf: [{ axContains: [{ role: "link", name: "12345" }] }] },
      },
      {
        id: 3,
        action: "navigate",
        target: { primary: { role: "RootWebArea", name: "http://localhost:3000/detail?id=12345" } },
        value: "http://localhost:3000/detail?id=12345",
        guard: { anyOf: [{ axContains: [{ role: "link", name: "12345" }] }] },
      },
      {
        id: 4,
        action: "extract",
        target: { primary: { role: "heading", name: "Member Detail - John A. Smith" } },
        output: "memberName",
        checkpoint: { anyOf: [{ axContains: [{ role: "heading", name: "Member Detail - John A. Smith" }] }] },
      },
    ],
    checkpoint: { outputsExtracted: true },
    metadata: { recordedAt: "2026-09-23T20:00:00Z", recordedBy: "test" },
    ...overrides,
  };
}

describe("ReplayEngine", () => {
  afterEach(() => {
    rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true });
  });

  // AC1: Given a saved artifact and valid params, when I run ReplayEngine,
  // then each step executes in order, guards and checkpoints verified, result is success.
  it("replays artifact successfully with extracted outputs", async () => {
    const surface = new MockSurface("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
      { role: "button", name: "Search" },
    ]);
    surface.setStateSequence([
      // State 0: search page (after step 1 navigate)
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "textbox", name: "Member ID" }, { role: "button", name: "Search" }],
        domSnapshot: "", frameUrls: [],
      },
      // State 1: still search page (step 2 guard check — same page)
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "textbox", name: "Member ID" }, { role: "button", name: "Search" }],
        domSnapshot: "", frameUrls: [],
      },
      // State 2: search results (after step 2 type — shows results)
      {
        url: "http://localhost:3000/search?q=12345",
        title: "Search Results",
        axTree: [{ role: "link", name: "12345" }, { role: "table", name: "Search Results" }],
        domSnapshot: "", frameUrls: [],
      },
      // State 3: detail page (after step 3 navigate)
      {
        url: "http://localhost:3000/detail?id=12345",
        title: "Member Detail",
        axTree: [{ role: "heading", name: "Member Detail - John A. Smith" }],
        domSnapshot: "", frameUrls: [],
      },
      // State 4: detail page (after step 4 extract — same page)
      {
        url: "http://localhost:3000/detail?id=12345",
        title: "Member Detail",
        axTree: [{ role: "heading", name: "Member Detail - John A. Smith" }],
        domSnapshot: "", frameUrls: [],
      },
    ]);

    const engine = new ReplayEngine({
      surface,
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
    });

    const result = await engine.run(mockArtifact(), { memberId: "12345" });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.memberName).toBeTruthy();
    }
  });

  // AC3: Given a replay where the page shows "No records found", when ErrorClassifier
  // examines the state, then it returns business-outcome with outcome member-not-found.
  it("returns business-outcome for member-not-found", async () => {
    const artifact = mockArtifact({
      steps: [
        {
          id: 1,
          action: "navigate",
          target: { primary: { role: "RootWebArea", name: "search" } },
          value: "http://localhost:3000/search",
        },
        {
          id: 2,
          action: "type",
          target: { primary: { role: "textbox", name: "Member ID" } },
          value: "{{memberId}}",
          guard: { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] },
          checkpoint: {
            anyOf: [
              { axContains: [{ role: "link", name: "12345" }] },
              { textContains: "No records found" },
            ],
          },
          onError: [
            {
              when: { anyOf: [{ textContains: "No records found" }] },
              handler: "fail",
              outcome: "member-not-found",
            },
          ],
        },
      ],
    });

    const surface = new MockSurface("http://localhost:3000/search", []);
    surface.setStateSequence([
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "textbox", name: "Member ID" }],
        domSnapshot: "", frameUrls: [],
      },
      {
        url: "http://localhost:3000/search?q=99999",
        title: "Search Results",
        axTree: [{ role: "heading", name: "No records found for Member ID: 99999" }],
        domSnapshot: "", frameUrls: [],
      },
      {
        url: "http://localhost:3000/search?q=99999",
        title: "Search Results",
        axTree: [{ role: "heading", name: "No records found for Member ID: 99999" }],
        domSnapshot: "", frameUrls: [],
      },
    ]);

    const engine = new ReplayEngine({
      surface,
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
    });

    const result = await engine.run(artifact, { memberId: "99999" });

    expect(result.status).toBe("business-outcome");
    if (result.status === "business-outcome") {
      expect(result.outcome).toBe("member-not-found");
    }
  });

  // AC4: Given a replay where a locator cannot be resolved, returns hard failure.
  it("returns failure when locator cannot be resolved", async () => {
    const artifact = mockArtifact({
      steps: [
        {
          id: 1,
          action: "navigate",
          target: { primary: { role: "RootWebArea", name: "search" } },
          value: "http://localhost:3000/search",
        },
        {
          id: 2,
          action: "type",
          target: { primary: { role: "textbox", name: "Non-existent Field" } },
          value: "test",
          guard: { anyOf: [{ axContains: [{ role: "textbox", name: "Non-existent Field" }] }] },
        },
      ],
    });

    const surface = new MockSurface("http://localhost:3000/search", []);
    surface.setStateSequence([
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "button", name: "Search" }], // No matching textbox
        domSnapshot: "", frameUrls: [],
      },
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "button", name: "Search" }],
        domSnapshot: "", frameUrls: [],
      },
    ]);

    const engine = new ReplayEngine({
      surface,
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
    });

    const result = await engine.run(artifact, { memberId: "12345" });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.stepId).toBe(2);
      expect(result.error).toBeTruthy();
    }
  });

  // AC8: Given the same artifact and params, when I run ReplayEngine twice,
  // then both results are identical (determinism).
  it("produces identical results for the same inputs (determinism)", async () => {
    const makeSurface = () => {
      const s = new MockSurface("http://localhost:3000/search", [
        { role: "textbox", name: "Member ID" },
      ]);
      s.setStateSequence([
        {
          url: "http://localhost:3000/search",
          title: "Search",
          axTree: [{ role: "textbox", name: "Member ID" }],
          domSnapshot: "", frameUrls: [],
        },
        {
          url: "http://localhost:3000/search",
          title: "Search",
          axTree: [{ role: "textbox", name: "Member ID" }],
          domSnapshot: "", frameUrls: [],
        },
      ]);
      return s;
    };

    const artifact = mockArtifact({
      steps: [
        {
          id: 1,
          action: "navigate",
          target: { primary: { role: "RootWebArea", name: "search" } },
          value: "http://localhost:3000/search",
        },
      ],
    });

    const engine1 = new ReplayEngine({
      surface: makeSurface(),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR + "-1"),
    });
    const engine2 = new ReplayEngine({
      surface: makeSurface(),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR + "-2"),
    });

    const result1 = await engine1.run(artifact, { memberId: "12345" });
    const result2 = await engine2.run(artifact, { memberId: "12345" });

    expect(result1.status).toBe(result2.status);

    rmSync(TEST_EVIDENCE_DIR + "-1", { recursive: true, force: true });
    rmSync(TEST_EVIDENCE_DIR + "-2", { recursive: true, force: true });
  });
});
