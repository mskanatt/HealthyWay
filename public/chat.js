// HealthyWay — Coach chat
//
// A normal back-and-forth chat with Gemini, with optional photo attachments
// (e.g. "here's a menu, what should I get?"). This talks to /api/chat on our
// own backend — same reasoning as app.js: the real Gemini key never reaches
// the browser.
//
// Note: this conversation lives only in memory for the current page load.
// Refreshing the page starts a new chat. See README.md if you want to persist
// it the way food/body scans are persisted in history.js.

(function () {
  "use strict";

  const messagesEl = document.getElementById("chat-messages");
  const emptyEl = document.getElementById("chat-empty");
  const formEl = document.getElementById("chat-form");
  const textInput = document.getElementById("chat-text-input");
  const imageInput = document.getElementById("chat-image-input");
  const attachPreview = document.getElementById("chat-attach-preview");
  const attachImg = document.getElementById("chat-attach-img");
  const attachRemoveBtn = document.getElementById("chat-attach-remove");
  const sendBtn = document.getElementById("chat-send-btn");
  const templatesEl = document.getElementById("chat-templates");

  if (!formEl) return; // chat markup not present on this page for some reason — bail quietly

  // Full conversation, kept for display AND for what we send to the backend.
  // Each entry: { role: "user"|"model", text, image?: base64, mimeType? }
  const conversation = [];
  let pendingFile = null;

  // ---------- image handling ----------

  function bytesToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read that image."));
      reader.readAsDataURL(file);
    });
  }

  /** Shrinks a photo before sending it to Gemini — menu/plate photos from a
   *  phone camera can be several MB and far larger than needed here. */
  function resizeForUpload(file, maxDim = 1024, quality = 0.75) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (blob) => resolve(blob || file),
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file); // fall back to the original file if resizing fails
      };
      img.src = url;
    });
  }

  imageInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    pendingFile = file;
    attachImg.src = URL.createObjectURL(file);
    attachPreview.hidden = false;
  });

  attachRemoveBtn.addEventListener("click", () => {
    pendingFile = null;
    imageInput.value = "";
    attachPreview.hidden = true;
  });

  // ---------- quick-question templates ----------

  templatesEl.querySelectorAll("[data-template]").forEach((btn) => {
    btn.addEventListener("click", () => {
      textInput.value = btn.dataset.template;
      textInput.focus();
      // A couple of templates expect a photo — nudge the user if none is attached yet.
      if (btn.dataset.template.toLowerCase().includes("photo") && !pendingFile) {
        imageInput.click();
      }
    });
  });

  // ---------- rendering ----------

  function addBubble(role, text, imageUrl) {
    emptyEl.hidden = true;
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${role}`;
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.className = "chat-bubble-img";
      img.alt = "";
      bubble.appendChild(img);
    }
    if (text) {
      const p = document.createElement("p");
      p.textContent = text;
      bubble.appendChild(p);
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function addTypingBubble() {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-bubble-model chat-bubble-typing";
    bubble.id = "chat-typing-bubble";
    bubble.innerHTML = `<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>`;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTypingBubble() {
    document.getElementById("chat-typing-bubble")?.remove();
  }

  // ---------- sending ----------

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text && !pendingFile) return;

    let imageBase64 = null;
    let mimeType = null;
    let bubbleImageUrl = null;

    if (pendingFile) {
      bubbleImageUrl = attachImg.src; // already an object URL, fine to reuse for display
      const resized = await resizeForUpload(pendingFile);
      imageBase64 = await bytesToBase64(resized);
      mimeType = "image/jpeg";
    }

    addBubble("user", text, bubbleImageUrl);
    conversation.push({ role: "user", text, image: imageBase64, mimeType });

    // Reset the composer immediately so the UI feels responsive.
    textInput.value = "";
    pendingFile = null;
    imageInput.value = "";
    attachPreview.hidden = true;
    sendBtn.disabled = true;
    addTypingBubble();

    try {
      // Only the most recent message needs its image resent — earlier photos
      // already did their job in past turns, and resending them every time
      // would make the request grow with every message.
      const payloadMessages = conversation.map((m, i) => {
        if (i === conversation.length - 1) return m;
        return { role: m.role, text: m.text };
      });

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadMessages }),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("The server sent back something unexpected. Please try again.");
      }
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      removeTypingBubble();
      addBubble("model", data.reply);
      conversation.push({ role: "model", text: data.reply });
    } catch (err) {
      removeTypingBubble();
      addBubble("model", err.message || "Something went wrong. Please try again.");
    } finally {
      sendBtn.disabled = false;
    }
  });

  // Let Enter send the message, Shift+Enter add a newline — standard chat-input behavior.
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });
})();
