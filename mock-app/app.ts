/**
 * Keystone CU mock app — a deliberately hostile stand-in for a legacy
 * back-office banking app: server-rendered tables, iframes, no test IDs,
 * non-semantic class names.
 *
 * Runtime conditions from the assignment brief can be injected per app
 * instance via `setFaults` (in-process) or `POST /__faults` (HTTP, for demos):
 * blocking notices, slow loads, transient 503s, session expiry mid-flow and
 * native confirmation dialogs. "Record not found", validation errors and
 * permission denials are data-driven and always on.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Account {
  type: string;
  number: string;
  balance: string;
}

interface Member {
  name: string;
  ssn: string;
  dob: string;
  restricted?: boolean;
  accounts: Account[];
}

export interface MockFaults {
  /** Paths whose pages render a blocking "System Notice" overlay. */
  interstitialPaths?: string[];
  /** Delay applied to every page response. */
  slowMs?: number;
  /** The next N page requests return "503 Service Temporarily Unavailable". */
  transientErrors?: number;
  /** Page requests allowed before every page shows "Session Expired". */
  expireSessionAfter?: number;
  /** The new-account form asks a native confirm() before submitting. */
  confirmOnSubmit?: boolean;
}

export interface MockApp {
  app: express.Express;
  setFaults(faults: MockFaults): void;
  resetFaults(): void;
}

const membersPath = path.join(__dirname, "data", "members.json");

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NOTICE_OVERLAY = `
  <div id="noticeOverlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000">
  <table style="background:#fff;margin:120px auto;border:2px solid #333" cellpadding="8">
  <tr><td class="cls5"><b>System Notice</b></td></tr>
  <tr><td>Scheduled maintenance tonight 11pm-2am. Some functions may be unavailable.</td></tr>
  <tr><td><input type="button" value="Acknowledge" onclick="document.getElementById('noticeOverlay').remove()"></td></tr>
  </table></div>`;

const SESSION_EXPIRED_PAGE = `<html><head><title>Keystone CU - Session Expired</title></head><body>
  <table border="0" cellpadding="4"><tr><td class="cls5">
  <b>Session Expired: Your session has timed out. Please log in again.</b>
  </td></tr></table></body></html>`;

const SERVICE_UNAVAILABLE_PAGE = `<html><head><title>Keystone CU - Unavailable</title></head><body>
  <table border="0" cellpadding="4"><tr><td class="cls5">
  <b>503 Service Temporarily Unavailable. Please try again.</b>
  </td></tr></table></body></html>`;

export function createMockApp(): MockApp {
  const members: Record<string, Member> = JSON.parse(readFileSync(membersPath, "utf-8"));
  let faults: MockFaults = {};
  let pageRequests = 0;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, "public")));

  // --- Fault control (test harness only; not part of the simulated app) ---
  app.post("/__faults", express.json(), (req, res) => {
    faults = req.body ?? {};
    pageRequests = 0;
    res.json({ ok: true, faults });
  });
  app.delete("/__faults", (_req, res) => {
    faults = {};
    pageRequests = 0;
    res.json({ ok: true });
  });

  // --- Fault injection for every page request below ---
  app.use(async (req, res, next) => {
    pageRequests++;
    if (faults.slowMs) await new Promise((r) => setTimeout(r, faults.slowMs));

    if (faults.transientErrors && faults.transientErrors > 0) {
      faults = { ...faults, transientErrors: faults.transientErrors - 1 };
      res.status(503).type("html").send(SERVICE_UNAVAILABLE_PAGE);
      return;
    }
    if (faults.expireSessionAfter !== undefined && pageRequests > faults.expireSessionAfter) {
      res.type("html").send(SESSION_EXPIRED_PAGE);
      return;
    }
    if (faults.interstitialPaths?.includes(req.path)) {
      const send = res.send.bind(res);
      res.send = (body?: unknown) =>
        send(typeof body === "string" ? body.replace("</body>", `${NOTICE_OVERLAY}</body>`) : body);
    }
    next();
  });

  app.get("/search", (req, res) => {
    const query = req.query.q as string | undefined;
    let html = `<html><head><title>Keystone CU - Member Search</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><h1>Member Servicing - Search</h1></td></tr>
      <tr><td class="cls2">
      <form action="/search" method="GET" name="searchForm">
      <table border="0" cellpadding="2" cellspacing="0">
      <tr><td>Member ID:</td><td><input type="text" name="q" aria-label="Member ID" value="${escapeHtml(query)}" size="20"></td>
      <td><input type="submit" value="Search" name="btnSearch" aria-label="Search"></td></tr>
      </table>
      </form></td></tr>`;

    if (query) {
      const member = members[query];
      if (member) {
        html += `<tr><td class="cls2">
          <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="80%">
          <tr class="cls4"><th>Member ID</th><th>Name</th><th>SSN</th><th>Accounts</th></tr>
          <tr><td><a href="/detail?id=${escapeHtml(query)}">${escapeHtml(query)}</a></td>
          <td>${member.name}</td><td>${member.ssn}</td>
          <td>${member.accounts.length}</td></tr>
          </table></td></tr>`;
      } else {
        html += `<tr><td class="cls2"><table border="0" cellpadding="4">
          <tr><td class="cls5"><b>No records found for Member ID: ${escapeHtml(query)}</b></td></tr>
          </table></td></tr>`;
      }
    }

    html += `</table></body></html>`;
    res.type("html").send(html);
  });

  app.get("/detail", (req, res) => {
    const id = req.query.id as string;
    const member = members[id];

    if (!member) {
      res.status(404).type("html").send(
        `<html><body><table border="0"><tr><td><b>Member not found: ${escapeHtml(id)}</b></td></tr>
        <tr><td><a href="/search">Back to Search</a></td></tr></table></body></html>`
      );
      return;
    }

    const accountsRows = member.accounts
      .map(
        (acct) => `<tr><td>${acct.type}</td><td>${acct.number}</td><td>${acct.balance}</td>
        <td><a href="/account-action?id=${id}&acct=${acct.number}">Manage</a></td></tr>`
      )
      .join("");

    res.type("html").send(`<html><head><title>Keystone CU - Member Detail</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><h1>Member Detail - ${member.name}</h1></td></tr>
      <tr><td class="cls2">
      <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="80%">
      <tr class="cls4"><th>Member ID</th><th>SSN</th><th>DOB</th></tr>
      <tr><td>${id}</td><td>${member.ssn}</td><td>${member.dob}</td></tr>
      </table></td></tr>
      <tr><td class="cls2">&nbsp;</td></tr>
      <tr><td class="cls2"><b>Accounts</b></td></tr>
      <tr><td class="cls2">
      <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="80%">
      <tr class="cls4"><th>Type</th><th>Account Number</th><th>Balance</th><th>Action</th></tr>
      ${accountsRows}
      </table></td></tr>
      <tr><td class="cls2">&nbsp;</td></tr>
      <tr><td class="cls2"><a href="/search">Back to Search</a> |
      <a href="/new-account?id=${id}">Open New Sub-Account</a></td></tr>
      </table></body></html>`);
  });

  // Account page — the target of the repeated "Manage" links on /detail
  app.get("/account-action", (req, res) => {
    const id = req.query.id as string;
    const member = members[id];
    const acct = member?.accounts.find((a) => a.number === req.query.acct);
    if (!member || !acct) {
      res.status(404).type("html").send(`<html><body><b>Account not found</b></body></html>`);
      return;
    }

    res.type("html").send(`<html><head><title>Keystone CU - Account</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><h1>Account Maintenance</h1></td></tr>
      <tr><td class="cls2">
      <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="60%">
      <tr class="cls4"><th>Field</th><th>Value</th></tr>
      <tr><td>Member</td><td>${member.name} (${id})</td></tr>
      <tr><td>Account Type</td><td>${acct.type}</td></tr>
      <tr><td>Account Number</td><td>${acct.number}</td></tr>
      <tr><td>Current Balance</td><td>${acct.balance}</td></tr>
      </table></td></tr>
      <tr><td class="cls2"><a href="/detail?id=${id}">Back to Member Detail</a></td></tr>
      </table></body></html>`);
  });

  app.get("/new-account", (req, res) => {
    const id = req.query.id as string;
    const member = members[id];
    if (!member) {
      res.status(404).type("html").send(`<html><body>Member not found</body></html>`);
      return;
    }
    if (member.restricted) {
      res.status(403).type("html").send(`<html><head><title>Keystone CU - Access Denied</title>
        <link rel="stylesheet" href="/style.css"></head><body>
        <table class="cls1" border="0" cellpadding="4"><tr><td class="cls5">
        <b>Access Denied: You do not have permission to open accounts for this member.</b>
        </td></tr></table></body></html>`);
      return;
    }

    const onSubmit = faults.confirmOnSubmit
      ? ` onsubmit="return confirm('Open this account? This cannot be undone.')"`
      : "";

    res.type("html").send(`<html><head><title>Keystone CU - New Sub-Account</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><h1>Open New Sub-Account for ${member.name} (${id})</h1></td></tr>
      <tr><td class="cls2">
      <form action="/new-account-confirm" method="POST" name="newAcctForm"${onSubmit}>
      <input type="hidden" name="memberId" value="${id}">
      <table border="0" cellpadding="2" cellspacing="0">
      <tr><td>Account Type:</td>
      <td><select name="acctType" aria-label="Account Type">
      <option value="savings">Savings</option>
      <option value="checking">Checking</option>
      <option value="cd">Certificate of Deposit</option>
      </select></td></tr>
      <tr><td>Initial Deposit:</td>
      <td><input type="text" name="initialDeposit" aria-label="Initial Deposit" value="" size="15"></td></tr>
      <tr><td>&nbsp;</td><td><input type="submit" value="Continue" name="btnContinue" aria-label="Continue">
      <input type="button" value="Cancel" name="btnCancel" aria-label="Cancel" onclick="history.back()"></td></tr>
      </table>
      </form></td></tr>
      </table></body></html>`);
  });

  app.post("/new-account-confirm", (req, res) => {
    const memberId = req.body.memberId;
    const acctType = req.body.acctType;
    const deposit = req.body.initialDeposit;

    const member = members[memberId];
    if (!member) {
      res.status(404).type("html").send(`<html><body>Member not found</body></html>`);
      return;
    }

    if (!deposit || isNaN(Number(deposit)) || Number(deposit) <= 0) {
      res.type("html").send(`<html><head><title>Keystone CU - Error</title>
        <link rel="stylesheet" href="/style.css"></head><body>
        <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
        <tr><td class="cls5"><b>Validation Error: Initial deposit must be a positive amount.</b></td></tr>
        <tr><td class="cls2"><a href="/new-account?id=${escapeHtml(memberId)}">Back to Form</a></td></tr>
        </table></body></html>`);
      return;
    }

    const newAcctNum = String(Math.floor(1000000000 + Math.random() * 9000000000));
    res.type("html").send(`<html><head><title>Keystone CU - Confirmation</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><h1>Sub-Account Opened Successfully</h1></td></tr>
      <tr><td class="cls2">
      <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="60%">
      <tr class="cls4"><th>Field</th><th>Value</th></tr>
      <tr><td>Member</td><td>${member.name} (${memberId})</td></tr>
      <tr><td>Account Type</td><td>${escapeHtml(acctType)}</td></tr>
      <tr><td>Account Number</td><td>${newAcctNum}</td></tr>
      <tr><td>Initial Deposit</td><td>$${escapeHtml(deposit)}</td></tr>
      </table></td></tr>
      <tr><td class="cls2">&nbsp;</td></tr>
      <tr><td class="cls2"><a href="/detail?id=${escapeHtml(memberId)}">Back to Member Detail</a></td></tr>
      </table></body></html>`);
  });

  // Main page with iframes (hostile: frames-based layout)
  app.get("/", (_req, res) => {
    res.type("html").send(`<html><head><title>Keystone CU - Member Servicing Portal</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="0" cellspacing="0" width="100%" height="100%">
      <tr><td class="cls2" height="40"><h1>Keystone Credit Union - Member Servicing Portal</h1></td></tr>
      <tr><td>
      <iframe src="/nav.html" name="navFrame" width="200" height="400" frameborder="0"></iframe>
      <iframe src="/search" name="mainFrame" width="700" height="400" frameborder="0"></iframe>
      </td></tr>
      </table></body></html>`);
  });

  // Navigation frame (hostile: link targets to mainFrame)
  app.get("/nav.html", (_req, res) => {
    res.type("html").send(`<html><head><link rel="stylesheet" href="/style.css"></head><body>
      <table border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls2"><b>Navigation</b></td></tr>
      <tr><td class="cls2"><a href="/search" target="mainFrame">Member Search</a></td></tr>
      <tr><td class="cls2"><a href="/new-account?id=12345" target="mainFrame">New Account Demo</a></td></tr>
      </table></body></html>`);
  });

  // Direct session-timeout page (kept for existing demos)
  app.get("/timeout", (_req, res) => {
    res.type("html").send(SESSION_EXPIRED_PAGE);
  });

  return {
    app,
    setFaults(next: MockFaults) {
      faults = { ...next };
      pageRequests = 0;
    },
    resetFaults() {
      faults = {};
      pageRequests = 0;
    },
  };
}
