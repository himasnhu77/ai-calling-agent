import "./style.css";

document.querySelector("#app").innerHTML = `
  <main class="container">
    <h1>AI Voice Call Tester</h1>
    <p class="subtitle">Start a call by sending a phone number to your backend endpoint.</p>

    <form id="call-form" class="card">
      <label for="phoneNumber">Phone Number</label>
      <input
        id="phoneNumber"
        name="phoneNumber"
        type="tel"
        placeholder="+91XXXXXXXXXX"
        required
      />
      <button type="submit" id="call-btn">Start Call</button>
    </form>

    <section class="card status-card">
      <h2>Response</h2>
      <pre id="response-box">Waiting for request...</pre>
    </section>
  </main>
`;

const form = document.querySelector("#call-form");
const phoneInput = document.querySelector("#phoneNumber");
const responseBox = document.querySelector("#response-box");
const callBtn = document.querySelector("#call-btn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phoneNumber = phoneInput.value.trim();

  callBtn.disabled = true;
  callBtn.textContent = "Calling...";
  responseBox.textContent = "Sending request...";

  try {
    const response = await fetch("/api/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phoneNumber }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    responseBox.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    responseBox.textContent = JSON.stringify(
      { success: false, error: error.message },
      null,
      2
    );
  } finally {
    callBtn.disabled = false;
    callBtn.textContent = "Start Call";
  }
});
