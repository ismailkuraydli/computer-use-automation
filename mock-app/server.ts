import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// In-memory member data — hostile: no API, only the UI surfaces this data
const membersPath = path.join(__dirname, "data", "members.json");
const members: Record<string, any> = JSON.parse(readFileSync(membersPath, "utf-8"));

const app = express();

// Parse URL-encoded bodies (legacy forms, no JSON API)
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Hostile routes: server-rendered HTML, no content-type headers, no API ---
// These routes serve server-rendered HTML that mimics legacy banking apps:
// - table-based layouts
// - no data-testid attributes
// - non-semantic class names (cls1, cls2, etc.)
// - iframes for navigation

app.get("/search", (req, res) => {
  const query = req.query.q as string | undefined;
  let html = `<html><head><title>Keystone CU - Member Search</title>
    <link rel="stylesheet" href="/style.css"></head><body>
    <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
    <tr><td class="cls2"><h1>Member Servicing - Search</h1></td></tr>
    <tr><td class="cls2">
    <form action="/search" method="GET" name="searchForm">
    <table border="0" cellpadding="2" cellspacing="0">
    <tr><td>Member ID:</td><td><input type="text" name="q" aria-label="Member ID" value="${query || ""}" size="20"></td>
    <td><input type="submit" value="Search" name="btnSearch" aria-label="Search"></td></tr>
    </table>
    </form></td></tr>`;

  if (query) {
    const member = members[query];
    if (member) {
      html += `<tr><td class="cls2">
        <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="80%">
        <tr class="cls4"><th>Member ID</th><th>Name</th><th>SSN</th><th>Accounts</th></tr>
        <tr><td><a href="/detail?id=${query}">${query}</a></td>
        <td>${member.name}</td><td>${member.ssn}</td>
        <td>${member.accounts.length}</td></tr>
        </table></td></tr>`;
    } else {
      html += `<tr><td class="cls2"><table border="0" cellpadding="4">
        <tr><td class="cls5"><b>No records found for Member ID: ${query}</b></td></tr>
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
      `<html><body><table border="0"><tr><td><b>Member not found: ${id}</b></td></tr>
      <tr><td><a href="/search">Back to Search</a></td></tr></table></body></html>`
    );
    return;
  }

  let accountsRows = "";
  for (const acct of member.accounts) {
    accountsRows += `<tr><td>${acct.type}</td><td>${acct.number}</td><td>${acct.balance}</td>
      <td><a href="/account-action?id=${id}&acct=${acct.number}">Manage</a></td></tr>`;
  }

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

app.get("/new-account", (req, res) => {
  const id = req.query.id as string;
  const member = members[id];
  if (!member) {
    res.status(404).type("html").send(`<html><body>Member not found</body></html>`);
    return;
  }

  res.type("html").send(`<html><head><title>Keystone CU - New Sub-Account</title>
    <link rel="stylesheet" href="/style.css"></head><body>
    <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
    <tr><td class="cls2"><h1>Open New Sub-Account for ${member.name} (${id})</h1></td></tr>
    <tr><td class="cls2">
    <form action="/new-account-confirm" method="POST" name="newAcctForm">
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

  // Simulate validation error
  if (!deposit || isNaN(Number(deposit)) || Number(deposit) <= 0) {
    res.type("html").send(`<html><head><title>Keystone CU - Error</title>
      <link rel="stylesheet" href="/style.css"></head><body>
      <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
      <tr><td class="cls5"><b>Validation Error: Initial deposit must be a positive amount.</b></td></tr>
      <tr><td class="cls2"><a href="/new-account?id=${memberId}">Back to Form</a></td></tr>
      </table></body></html>`);
    return;
  }

  // Confirmation page
  const newAcctNum = String(Math.floor(1000000000 + Math.random() * 9000000000));
  res.type("html").send(`<html><head><title>Keystone CU - Confirmation</title>
    <link rel="stylesheet" href="/style.css"></head><body>
    <table class="cls1" border="0" cellpadding="4" cellspacing="0" width="100%">
    <tr><td class="cls2"><h1>Sub-Account Opened Successfully</h1></td></tr>
    <tr><td class="cls2">
    <table border="1" cellpadding="4" cellspacing="0" class="cls3" width="60%">
    <tr class="cls4"><th>Field</th><th>Value</th></tr>
    <tr><td>Member</td><td>${member.name} (${memberId})</td></tr>
    <tr><td>Account Type</td><td>${acctType}</td></tr>
    <tr><td>Account Number</td><td>${newAcctNum}</td></tr>
    <tr><td>Initial Deposit</td><td>$${deposit}</td></tr>
    </table></td></tr>
    <tr><td class="cls2">&nbsp;</td></tr>
    <tr><td class="cls2"><a href="/detail?id=${memberId}">Back to Member Detail</a></td></tr>
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

// Session timeout simulation endpoint
app.get("/timeout", (_req, res) => {
  res.type("html").send(`<html><body>
    <table border="0" cellpadding="4"><tr><td class="cls5">
    <b>Session Expired: Your session has timed out. Please log in again.</b>
    </td></tr></table></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Keystone CU mock app running on http://localhost:${PORT}`);
});
