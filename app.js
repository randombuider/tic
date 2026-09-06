const form = document.getElementById("scanForm");
const input = document.getElementById("wallet");
const btn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");
const card = document.getElementById("result");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "status error" : "status";
}

function isValidAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const wallet = input.value.trim();

  if (!isValidAddress(wallet)) {
    setStatus("Enter a valid 0x... EVM address.", true);
    return;
  }

  btn.disabled = true;
  btn.textContent = "SCANNING...";
  card.classList.remove("show");
  setStatus("Locating first transaction, analyzing activity...");

  try {
    const res = await fetch("/api/scan-tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Scan failed.");
    }

    if (data.transactionCount === 0) {
      setStatus(data.message || "No activity found for this wallet.", true);
      return;
    }

    document.getElementById("species").textContent = data.species;
    document.getElementById("walletEcho").textContent = data.wallet;
    document.getElementById("ageDays").textContent = `${data.ageDays} DAYS`;
    document.getElementById("firstSeen").textContent = data.firstSeen.slice(0, 10);
    document.getElementById("txCount").textContent = data.transactionCount;
    document.getElementById("contractCount").textContent = data.contractCount;
    document.getElementById("tickScore").textContent = data.tickScore;

    card.classList.add("show");
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "SCAN TICK";
  }
});
