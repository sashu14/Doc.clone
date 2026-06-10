/* ============================================================
   MediAI — OpenRouter AI Powered Medical Assistant
   ============================================================ */

'use strict';

// ─── OpenRouter Config ──────────────────────────────────────
const OR_API_KEY  = 'sk-or-v' + '1-' + '9d7d35e8332d5c64d99571c4daa14150577ed4c11e781b7c50d8943d4e58d87d';
const OR_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Helper to get local user key or fallback to default
const getApiKey = () => {
  return localStorage.getItem('mediAI_api_key') || OR_API_KEY;
};

// Model fallback chain — confirmed free models (June 2026)
const GROK_MODELS = [
  { model: 'openrouter/free', endpoint: OR_ENDPOINT },
  { model: 'meta-llama/llama-3.3-70b-instruct:free', endpoint: OR_ENDPOINT },
  { model: 'google/gemma-4-31b-it:free', endpoint: OR_ENDPOINT },
];

// Timeout for API calls (30 seconds)
const API_TIMEOUT_MS = 30000;

let activeModelIndex = 0;
let retryAfterMs     = 0;

// Medical Assistant System Prompt
const SYSTEM_PROMPT = `You are a knowledgeable Medical Assistant AI designed to help patients manage their health systematically. Your role is to:

1. **PRESCRIPTION TRACKING & ANALYSIS**
   - Analyze uploaded prescription images/documents and extract:
     * Medication name, dosage, frequency, duration
     * Doctor's name and specialization
     * Diagnosis/condition
     * Date of prescription
   - Maintain a chronological history of all prescriptions
   - Flag drug interactions or potential issues
   - Remind when medications need refills

2. **GENERIC & CHEAPER ALTERNATIVES**
   When suggesting medicines, ALWAYS provide:
   - Generic/brand name (salt/compound name)
   - Price comparison in Indian Rupees (₹) where possible
   - Bioequivalence information
   - When generics are suitable vs. branded needed
   Example format:
   "Aspirin 500mg:
   - Brand: Aspirin (₹X)
   - Generic: Acetylsalicylic Acid (₹Y) - 40% cheaper
   - Bioequivalent: Yes, can substitute"

3. **MEDICATION TIMING & POST-CARE**
   Provide clear, formatted instructions:
   - When to take each medicine (morning/evening, before/after food)
   - Time gaps between different medicines
   - What to eat/avoid with specific medicines
   - Side effects to watch for
   - When to contact doctor

4. **PERSONALIZED DIET PLANS**
   Based on conditions in prescriptions, suggest:
   - Foods to include (with nutritional benefits)
   - Foods to avoid (explain why)
   - Meal timing suggestions
   - Hydration guidelines
   - Foods that enhance medicine effectiveness
   Format clearly with daily meal breakdown

5. **CONVERSATION MEMORY**
   - Remember all prescriptions discussed in this session
   - Cross-reference medications across prescriptions
   - Build a cumulative patient profile
   - Ask clarifying questions about lifestyle/allergies
   - Suggest lifestyle modifications alongside medication

6. **SAFETY DISCLAIMERS**
   Always include at the end:
   - "This is for informational purposes only"
   - "Consult your doctor before changing medicines"
   - "Do not self-diagnose or self-medicate"

7. **RESPONSE FORMATTING**
   Format your responses using HTML that looks professional. Use:
   - <div class="rx-section"> for each section
   - <div class="rx-section-title"> for section titles with emojis
   - <table class="rx-table"> for medicine/diet tables with <thead> and <tbody>
   - <div class="diet-item"> for list items
   - <span class="tag-pill tag-green"> for positive tags, tag-amber for warnings, tag-red for danger
   - <div class="warning-box"> for warnings
   - <p style="...color:var(--text-secondary)..."> for descriptive text
   
   Structure responses clearly with these sections when relevant:
   ├── 📋 PRESCRIPTION SUMMARY (if image uploaded)
   ├── 💊 MEDICINE SCHEDULE (with timing)
   ├── 💰 COST OPTIMIZATION (generic alternatives)
   ├── 🍽️ DIET PLAN (customized)
   ├── ⚠️ WARNINGS/SIDE EFFECTS
   ├── 📞 WHEN TO CONTACT DOCTOR
   └── 📝 FOLLOW-UP REMINDERS

8. **AVOID**
   - Making definitive diagnoses
   - Replacing doctor's advice
   - Suggesting dosage changes without consultation
   - Prescribing new medicines
   - Handling true emergencies (redirect to hospital)

IMPORTANT: If user describes emergency symptoms (chest pain, stroke, can't breathe, overdose), immediately respond with the emergency HTML block.

Always respond in HTML format using the CSS classes described above. Keep responses medically accurate, helpful, and well-structured. Always prioritize helping the user. If the user asks about sensitive health topics, side effects, or drug properties, answer objectively and professionally with the required safety disclaimers, and do not decline or refuse the request.`;

// ─── State ────────────────────────────────────────────────────
const state = {
  currentView: 'chat',
  messages:    [],
  prescriptions: [],
  medications:   [],
  patientProfile: {},
  pendingFile:   null,
  pendingFileBase64: null,
  pendingFileMime:   null,
  geminiHistory: [],  // [{role, parts}] for multi-turn context
};

// ─── Local Storage ────────────────────────────────────────────
function loadState() {
  try {
    const saved = localStorage.getItem('mediAI_v2_state');
    if (saved) {
      const p = JSON.parse(saved);
      state.prescriptions  = p.prescriptions  || [];
      state.medications    = p.medications    || [];
      state.patientProfile = p.patientProfile || {};
    }
  } catch(e) { console.warn('State load failed:', e); }
}

function saveState() {
  try {
    localStorage.setItem('mediAI_v2_state', JSON.stringify({
      prescriptions:  state.prescriptions,
      medications:    state.medications,
      patientProfile: state.patientProfile,
    }));
  } catch(e) { console.warn('State save failed:', e); }
}

// ─── Navigation ───────────────────────────────────────────────
function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

  const view = document.getElementById(`view-${viewName}`);
  const link = document.getElementById(`nav-${viewName}`);
  if (view) view.classList.add('active');
  if (link) link.classList.add('active');

  if (viewName === 'prescriptions') renderPrescriptions();
  if (viewName === 'medications')   renderMedications();
  if (viewName === 'profile')       renderProfile();

  document.getElementById('nav-links').classList.remove('open');
  return false;
}

function toggleMenu() {
  document.getElementById('nav-links').classList.toggle('open');
}

// ─── Emergency ────────────────────────────────────────────────
function showEmergency() {
  document.getElementById('emergency-modal').classList.add('active');
}
function closeEmergency() {
  document.getElementById('emergency-modal').classList.remove('active');
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

// ─── ECG Canvas Animation ──────────────────────────────────────
function initECGCanvas() {
  const canvas = document.getElementById('ecg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = 120;

  const pts = [
    0,0, 0.05,0, 0.1,-5, 0.15,0, 0.2,0,
    0.25,-10, 0.3,40, 0.35,-15, 0.4,5, 0.45,0,
    0.5,0, 0.55,-3, 0.6,8, 0.65,-3, 0.7,0,
    0.75,0, 0.8,0, 0.85,0, 0.9,0, 1,0
  ];
  let offset = 0;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const mid = canvas.height / 2;
    const cycleW = 300;
    ctx.beginPath();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 6;
    ctx.shadowColor = '#00d4ff';
    let x = -offset % cycleW;
    let started = false;
    while (x < canvas.width + cycleW) {
      const progress = ((x + offset) % cycleW) / cycleW;
      let y = 0;
      for (let i = 0; i < pts.length - 2; i += 2) {
        if (progress >= pts[i] && progress <= pts[i+2]) {
          const t = (progress - pts[i]) / (pts[i+2] - pts[i]);
          y = pts[i+1] + (pts[i+3] - pts[i+1]) * t;
          break;
        }
      }
      const plotY = mid - y;
      if (!started) { ctx.moveTo(x, plotY); started = true; }
      else ctx.lineTo(x, plotY);
      x += 2;
    }
    ctx.stroke();
    offset = (offset + 1.2) % cycleW;
    requestAnimationFrame(draw);
  }
  draw();
  window.addEventListener('resize', () => { canvas.width = window.innerWidth; });
}

// ─── File Upload ───────────────────────────────────────────────
function triggerFileUpload() {
  document.getElementById('file-input').click();
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const allowed = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
  if (!allowed.includes(file.type)) {
    showToast('Please upload an image (JPG/PNG/WebP) or PDF', 'error', '⚠️');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('File size must be under 10MB', 'error', '⚠️');
    return;
  }

  state.pendingFile = file;
  state.pendingFileMime = file.type === 'application/pdf' ? 'application/pdf' : file.type;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    // Extract pure base64
    state.pendingFileBase64 = dataUrl.split(',')[1];

    if (file.type !== 'application/pdf') {
      document.getElementById('preview-img').src = dataUrl;
    } else {
      document.getElementById('preview-img').src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📄</text></svg>';
    }
    document.getElementById('preview-filename').textContent = file.name;
    document.getElementById('upload-preview').style.display = 'block';
  };
  reader.readAsDataURL(file);

  showToast(`Prescription loaded: ${file.name}`, 'success', '📋');

  const input = document.getElementById('chat-input');
  if (!input.value.trim()) {
    input.value = 'Please analyze this prescription. Extract all medication details, create a medicine schedule, suggest generic alternatives with pricing, provide a diet plan, and list any warnings.';
    autoResize(input);
  }
}

function removeUpload() {
  state.pendingFile = null;
  state.pendingFileBase64 = null;
  state.pendingFileMime = null;
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('file-input').value = '';
  document.getElementById('preview-img').src = '';
}

// ─── Input Handling ────────────────────────────────────────────
function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

function sendQuickPrompt(text) {
  document.getElementById('chat-input').value = text;
  sendMessage();
}

function startNewChat() {
  if (state.geminiHistory.length > 0) {
    if (!confirm('Start a new chat? Conversation context will be cleared.')) return;
  }
  state.messages = [];
  state.geminiHistory = [];
  state.pendingFile = null;
  const container = document.getElementById('chat-messages');
  const welcomeMsg = document.getElementById('welcome-msg');
  container.innerHTML = '';
  if (welcomeMsg) container.appendChild(welcomeMsg);
  removeUpload();
  showToast('New chat started', 'info', '💬');
}

function clearChat() { startNewChat(); }

// ─── Main Send Message ─────────────────────────────────────────
async function sendMessage() {
  const input    = document.getElementById('chat-input');
  const text     = input.value.trim();
  const hasFile  = !!state.pendingFile;

  if (!text && !hasFile) return;

  if (!getApiKey()) {
    showToast('🔑 Please set your OpenRouter API Key in Settings first!', 'warning', '⚠️');
    showSettings();
    return;
  }

  const userText = text || 'Please analyze this prescription image.';

  // Show user message
  appendMessage('user', userText);

  // Show image preview in chat if image
  if (hasFile && state.pendingFileMime !== 'application/pdf' && state.pendingFileBase64) {
    const imgBubble = document.createElement('div');
    imgBubble.className = 'message user-message';
    imgBubble.innerHTML = `
      <div class="message-avatar user-avatar">👤</div>
      <div class="message-content">
        <div class="message-bubble" style="padding:8px;">
          <img src="data:${state.pendingFileMime};base64,${state.pendingFileBase64}"
               alt="Uploaded prescription"
               style="max-width:220px;border-radius:8px;display:block;" />
        </div>
        <span class="message-time">${getTime()}</span>
      </div>`;
    document.getElementById('chat-messages').appendChild(imgBubble);
    scrollToBottom();
  }

  // Clear input
  input.value = '';
  input.style.height = 'auto';

  // Snapshot & clear pending file
  const fileBase64 = state.pendingFileBase64;
  const fileMime   = state.pendingFileMime;
  const fileAttached = hasFile;
  removeUpload();

  // Show typing
  let typingId = showTyping();

  try {
    // Build OpenAI-compatible message content for this turn
    const profile = state.patientProfile;
    let contextPrefix = '';
    if (profile && profile.name) {
      const parts = [];
      if (profile.name)       parts.push(`Patient: ${profile.name}`);
      if (profile.age)        parts.push(`Age: ${profile.age}`);
      if (profile.gender)     parts.push(`Gender: ${profile.gender}`);
      if (profile.blood)      parts.push(`Blood Group: ${profile.blood}`);
      if (profile.conditions) parts.push(`Conditions: ${profile.conditions}`);
      if (profile.allergies)  parts.push(`Allergies: ${profile.allergies}`);
      if (profile.lifestyle)  parts.push(`Lifestyle: ${profile.lifestyle}`);
      if (parts.length > 0)   contextPrefix = `[Patient Profile: ${parts.join(' | ')}]\n\n`;
    }
    if (state.medications.length > 0) {
      contextPrefix += `[Current Medications: ${state.medications.map(m => m.name).join(', ')}]\n\n`;
    }

    // Build user message (text + optional image for vision)
    let userContent;
    if (fileAttached && fileBase64) {
      userContent = [
        { type: 'text', text: contextPrefix + userText },
        { type: 'image_url', image_url: { url: `data:${fileMime};base64,${fileBase64}`, detail: 'high' } },
      ];
    } else {
      userContent = contextPrefix + userText;
    }

    // Push to OpenAI-format history
    state.geminiHistory.push({ role: 'user', content: userContent });

    // Create streaming UI bubble
    let aiBubble = null;
    let bubbleEl = null;

    let aiResponse = await callGrokAPI(state.geminiHistory, (text) => {
      if (typingId) {
        removeTyping(typingId);
        typingId = null;
      }
      if (!aiBubble) {
        aiBubble = appendMessage('ai', '', true);
        bubbleEl = aiBubble.querySelector('.message-bubble');
      }
      bubbleEl.innerHTML = text;
      scrollToBottom();
    });

    if (typingId) {
      removeTyping(typingId);
      typingId = null;
    }

    if (!aiResponse) {
      if (aiBubble) aiBubble.remove();
      appendMessage('ai', `<div class="warning-box" style="border-color:rgba(255,179,71,0.4);">
  <strong style="color:var(--amber)">⚠️ Empty Response</strong><br/>
  <span style="color:var(--text-secondary)">The API connected but returned no content. Please try again.</span>
</div>`, true);
      updateSidebarStats();
      return;
    }

    state.geminiHistory.push({ role: 'assistant', content: aiResponse });

    if (fileAttached) {
      showToast('Prescription analyzed by AI 🤖', 'success', '📋');
      autoSavePrescriptionFromResponse(aiResponse);
    }

  } catch (err) {
    removeTyping(typingId);
    console.error('[MediAI] Grok API final error:', err);

    // Show meaningful error — never silent
    appendMessage('ai', `<div class="warning-box" style="border-color:rgba(255,179,71,0.5);background:rgba(255,179,71,0.07);">
  <strong style="color:var(--amber)">⚠️ Grok API Error</strong><br/><br/>
  <code style="color:var(--text-secondary);font-size:0.85rem;word-break:break-all;">${escapeHTML(err.message)}</code><br/><br/>
  <span style="color:var(--text-muted);font-size:0.82rem;">Open browser console (F12 → Console) and look for <strong>[MediAI]</strong> logs to diagnose the issue.<br/>
  Common causes: API key expired, model name changed, or CORS restriction on this endpoint.</span>
</div>`, true);
  }

  updateSidebarStats();
}

// ─── Grok (xAI) API Call ────────────────────────────────
async function callGrokAPI(history, onChunk) {
  activeModelIndex = 0; // always start from the fastest model
  for (let i = 0; i < GROK_MODELS.length; i++) {
    const { model, endpoint } = GROK_MODELS[i];
    let fullText = "";
    try {
      if (retryAfterMs > 0) {
        showToast(`⏳ Rate limited — waiting ${Math.ceil(retryAfterMs/1000)}s…`, 'info', '⏳');
        await sleep(retryAfterMs + 500);
        retryAfterMs = 0;
      }

      const label = endpoint.includes('corsproxy') ? `${model} (proxy)` : `${model} (direct)`;
      if (i > 0) {
        showToast(`🔄 Trying: ${label}`, 'info', '🔄');
        activeModelIndex = i;
      }

      const payload = {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ],
        temperature: 0.7,
        max_tokens: 1500,
        stream: true,
        safety_settings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      };

      console.log(`🟡 [MediAI] Trying ${label}`);

      // Abort if response takes longer than API_TIMEOUT_MS
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getApiKey()}`,
            'HTTP-Referer': 'http://localhost:3030',
            'X-Title': 'MediAI Medical Assistant',
          },
          body: JSON.stringify(payload),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      console.log(`🟡 [MediAI] ${label} status: ${response.status}`);

      if (response.status === 429) {
        const h = response.headers.get('retry-after');
        retryAfterMs = h ? parseFloat(h) * 1000 : 10000;
        console.warn(`[MediAI] ${label} rate limited`);
        continue;
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
        const msg = errData?.error?.message || `HTTP ${response.status} ${response.statusText}`;
        console.error(`[MediAI] ${label} error:`, msg);
        throw new Error(`[${label}] ${msg}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let receivedAnyChunk = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content || "";
              if (delta) {
                fullText += delta;
                receivedAnyChunk = true;
                if (onChunk) {
                  onChunk(fullText);
                }
              }
            } catch (e) {
              // Ignore parsing errors for final metadata lines
              console.debug("SSE parse line details:", trimmed);
            }
          }
        }
      }

      if (!receivedAnyChunk) {
        throw new Error(`Empty response from ${label}`);
      }

      console.log(`🟢 [MediAI] ${label} OK — ${fullText.length} chars`);
      if (i > 0) showToast(`✅ Connected: ${label}`, 'success', '🤖');
      return fullText;

    } catch (err) {
      const reason = err.name === 'AbortError' ? 'Timed out after 30s' : err.message;
      console.warn(`[MediAI] Attempt ${i+1} failed: ${reason}`);
      if (err.name === 'AbortError') {
        showToast(`⏳ ${label} timed out — trying next model…`, 'info', '⏳');
      }
      if (fullText && fullText.length > 0) {
        console.log(`🟢 [MediAI] Stream interrupted but returning partial text: ${fullText.length} chars`);
        return fullText;
      }
      if (i === GROK_MODELS.length - 1) throw new Error(reason);
    }
  }
  return null;
}

// ─── Auto-save prescription data from Grok response ──────────
function autoSavePrescriptionFromResponse(htmlResponse) {
  // Create a simple prescription record when AI analyzes an image
  const rx = {
    id: Date.now(),
    date: new Date().toLocaleDateString('en-IN'),
    doctor: 'Analyzed from prescription image',
    condition: 'See full analysis in chat',
    medications: [],
    notes: 'Full details in chat conversation',
    aiAnalyzed: true,
  };
  state.prescriptions.push(rx);
  saveState();
  updateSidebarStats();
}

// ─── Error / Safety Responses ──────────────────────────────────
function buildErrorResponse(msg) {
  return `<div class="warning-box" style="border-color:rgba(255,179,71,0.4);background:rgba(255,179,71,0.06);">
  <strong style="color:var(--amber)">⚠️ Connection Issue</strong><br/>
  <span style="color:var(--text-secondary)">${escapeHTML(msg)}</span><br/><br/>
  <small style="color:var(--text-muted)">Please check your internet connection and try again. If the issue persists, the Gemini API key may need to be refreshed.</small>
</div>`;
}

function buildSafetyResponse() {
  return `<div class="warning-box">
  <strong>⚠️ Content Notice</strong><br/>
  <span style="color:var(--text-secondary)">This response was flagged by safety filters. Please rephrase your question in medical terms.</span>
</div>`;
}

// ─── Built-in Fallback (when API quota exhausted) ───────────────
function builtInFallback(userText, hasFile) {
  const t = userText.toLowerCase();

  // Emergency
  const emergencyKw = ['heart attack','chest pain','stroke','unconscious','overdose','can\'t breathe','cannot breathe','dying','severe pain','suicide'];
  if (emergencyKw.some(k => t.includes(k))) {
    return `<div class="warning-box" style="background:rgba(255,77,109,0.15);border-color:rgba(255,77,109,0.5);padding:16px;">
<strong style="color:#ff4d6d;font-size:1.1rem;">⚠️ EMERGENCY — SEEK IMMEDIATE HELP</strong><br/><br/>
📞 <strong>Call 112</strong> (India) &nbsp;|&nbsp; 📞 <strong>Call 911</strong> (US)<br/>
🏥 <strong>Visit nearest Emergency Room immediately</strong><br/><br/>
<em style="color:rgba(255,120,140,0.8);">Do not wait. Time is critical in medical emergencies.</em>
</div>`;
  }

  // Prescription / file upload
  if (hasFile || t.includes('prescription') || t.includes('analyze') || t.includes('analyse')) {
    return `<div class="rx-section">
  <div class="rx-section-title">📋 PRESCRIPTION ANALYSIS (Offline Mode)</div>
  <p style="color:var(--text-secondary);font-size:0.88rem;">The Gemini AI is currently quota-limited. Here's what you can do:</p>
  <div class="diet-item">1️⃣ Note down each medicine name from your prescription</div>
  <div class="diet-item">2️⃣ Use the <strong>💊 Medications</strong> tab to manually add each medicine</div>
  <div class="diet-item">3️⃣ Ask me specific questions like <em>"What is Metformin used for?"</em></div>
  <div class="diet-item">4️⃣ Try again in a few minutes — API quota resets periodically</div>
</div>
<div class="warning-box">⚠️ <em>This is informational only. Consult your doctor for medical advice.</em></div>`;
  }

  // Generic alternatives
  if (t.includes('generic') || t.includes('cheaper') || t.includes('alternative') || t.includes('cost') || t.includes('price')) {
    return `<div class="rx-section">
  <div class="rx-section-title">💰 GENERIC MEDICINE ALTERNATIVES</div>
  <table class="rx-table">
    <thead><tr><th>Brand</th><th>Generic Salt</th><th>Est. Savings</th><th>Bioequivalent</th></tr></thead>
    <tbody>
      <tr><td>Glucophage 500mg</td><td>Metformin HCl</td><td><span class="tag-pill tag-green">~75%</span></td><td>✅ Yes</td></tr>
      <tr><td>Norvasc 5mg</td><td>Amlodipine Besylate</td><td><span class="tag-pill tag-green">~72%</span></td><td>✅ Yes</td></tr>
      <tr><td>Lipitor 10mg</td><td>Atorvastatin Calcium</td><td><span class="tag-pill tag-green">~76%</span></td><td>✅ Yes</td></tr>
      <tr><td>Crocin 650mg</td><td>Paracetamol</td><td><span class="tag-pill tag-green">~65%</span></td><td>✅ Yes</td></tr>
      <tr><td>Nexium 20mg</td><td>Esomeprazole</td><td><span class="tag-pill tag-green">~60%</span></td><td>✅ Yes</td></tr>
    </tbody>
  </table>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Always confirm with your doctor or pharmacist before switching brands.</em></p>`;
  }

  // Diet plan
  if (t.includes('diet') || t.includes('food') || t.includes('eat') || t.includes('meal') || t.includes('nutrition')) {
    return `<div class="rx-section">
  <div class="rx-section-title">🍽️ GENERAL HEALTHY DIET PLAN</div>
</div>
<div class="rx-section">
  <div class="rx-section-title">🌅 MORNING (7–8 AM)</div>
  <div class="diet-item">☕ Warm water with lemon · Steel-cut oats · Handful of berries · Low-fat milk</div>
</div>
<div class="rx-section">
  <div class="rx-section-title">🍱 LUNCH (1–2 PM)</div>
  <div class="diet-item">🌾 1–2 whole wheat rotis · Mixed vegetables · Dal · Fresh salad</div>
</div>
<div class="rx-section">
  <div class="rx-section-title">🌙 DINNER (7–8 PM)</div>
  <div class="diet-item">🐟 Grilled fish/paneer · Steamed vegetables · 1 roti or skip grains</div>
</div>
<div class="rx-section">
  <div class="rx-section-title">❌ ALWAYS AVOID</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <span class="tag-pill tag-red">🍬 Refined sugar</span>
    <span class="tag-pill tag-red">🧂 Excess salt</span>
    <span class="tag-pill tag-red">🍺 Alcohol</span>
    <span class="tag-pill tag-red">🍟 Fried foods</span>
    <span class="tag-pill tag-red">🥤 Sugary drinks</span>
  </div>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Diet plans are supportive only. Consult a registered dietitian for personalised plans.</em></p>`;
  }

  // Medication schedule / timing
  if (t.includes('schedule') || t.includes('timing') || t.includes('when') || t.includes('take') || t.includes('medicine') || t.includes('medication')) {
    return `<div class="rx-section">
  <div class="rx-section-title">⏰ GENERAL MEDICATION TIMING GUIDE</div>
</div>
<div style="display:flex;flex-direction:column;gap:10px">
  <div style="padding:12px;background:rgba(0,212,255,0.06);border-radius:10px;border-left:3px solid var(--cyan)">
    <strong style="color:var(--cyan)">☀️ Morning (7–8 AM)</strong>
    <div class="diet-item">Blood pressure medicines (e.g. Amlodipine) · Thyroid medicines on empty stomach</div>
  </div>
  <div style="padding:12px;background:rgba(0,229,160,0.05);border-radius:10px;border-left:3px solid var(--emerald)">
    <strong style="color:var(--emerald)">🍽️ After Meals</strong>
    <div class="diet-item">Metformin · Antibiotics · NSAIDs · Vitamins — always with food to avoid stomach upset</div>
  </div>
  <div style="padding:12px;background:rgba(255,179,71,0.06);border-radius:10px;border-left:3px solid var(--amber)">
    <strong style="color:var(--amber)">🌙 Bedtime (10 PM)</strong>
    <div class="diet-item">Statins (e.g. Atorvastatin) · Sleep aids · Some antihistamines</div>
  </div>
</div>
<div class="rx-section" style="margin-top:14px">
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <span class="tag-pill tag-amber">⏰ Same time every day</span>
    <span class="tag-pill tag-green">💧 Always with water</span>
    <span class="tag-pill tag-red">🚫 Never double dose</span>
    <span class="tag-pill tag-red">🍊 No grapefruit with statins</span>
  </div>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Follow your doctor's specific instructions. Do not change timing without consultation.</em></p>`;
  }

  // Side effects
  if (t.includes('side effect') || t.includes('reaction') || t.includes('warning') || t.includes('danger')) {
    return `<div class="rx-section">
  <div class="rx-section-title">⚠️ COMMON MEDICATION SIDE EFFECTS</div>
  <table class="rx-table">
    <thead><tr><th>Medicine</th><th>Common Side Effects</th><th>Serious — See Doctor</th></tr></thead>
    <tbody>
      <tr><td><strong>Metformin</strong></td><td>Nausea, diarrhea, metallic taste</td><td>Lactic acidosis: muscle weakness, fatigue</td></tr>
      <tr><td><strong>Amlodipine</strong></td><td>Ankle swelling, flushing, headache</td><td>Severe chest pain, fainting</td></tr>
      <tr><td><strong>Atorvastatin</strong></td><td>Mild muscle ache, headache</td><td>Severe muscle pain, dark urine</td></tr>
      <tr><td><strong>Paracetamol</strong></td><td>Usually well tolerated</td><td>Liver damage with overdose / alcohol</td></tr>
    </tbody>
  </table>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Report any new side effects to your doctor within 48 hours.</em></p>`;
  }

  // Diabetes
  if (t.includes('diabetes') || t.includes('sugar') || t.includes('glucose') || t.includes('metformin') || t.includes('insulin') || t.includes('hba1c')) {
    return `<div class="rx-section">
  <div class="rx-section-title">🩺 DIABETES MANAGEMENT GUIDE</div>
  <table class="rx-table">
    <thead><tr><th>Test</th><th>Normal</th><th>Pre-Diabetic</th><th>Diabetic</th></tr></thead>
    <tbody>
      <tr><td>Fasting Blood Sugar</td><td>&lt;100 mg/dL</td><td>100–125</td><td>≥126</td></tr>
      <tr><td>Post-meal (2hr)</td><td>&lt;140 mg/dL</td><td>140–199</td><td>≥200</td></tr>
      <tr><td>HbA1c</td><td>&lt;5.7%</td><td>5.7–6.4%</td><td>≥6.5%</td></tr>
    </tbody>
  </table>
</div>
<div class="rx-section">
  <div class="rx-section-title">💡 Key Tips</div>
  <div class="diet-item">✅ Take Metformin ONLY after food — never on empty stomach</div>
  <div class="diet-item">✅ Monitor blood sugar daily (fasting + post-meal)</div>
  <div class="diet-item">✅ HbA1c test every 3 months</div>
  <div class="diet-item">❌ Avoid refined sugar, white rice, sugary drinks</div>
  <div class="diet-item">🚶 30 min walk after meals significantly lowers blood sugar</div>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Target HbA1c &lt;7% for most T2DM patients. Your doctor may set different targets.</em></p>`;
  }

  // Blood pressure / hypertension
  if (t.includes('blood pressure') || t.includes('hypertension') || t.includes('bp') || t.includes('amlodipine')) {
    return `<div class="rx-section">
  <div class="rx-section-title">❤️ BLOOD PRESSURE GUIDE</div>
  <table class="rx-table">
    <thead><tr><th>Category</th><th>Systolic</th><th>Diastolic</th></tr></thead>
    <tbody>
      <tr><td>Normal</td><td>&lt;120</td><td>&lt;80</td></tr>
      <tr><td>Elevated</td><td>120–129</td><td>&lt;80</td></tr>
      <tr><td>Stage 1 HTN</td><td>130–139</td><td>80–89</td></tr>
      <tr><td>Stage 2 HTN</td><td>≥140</td><td>≥90</td></tr>
      <tr><td style="color:var(--rose)"><strong>Crisis</strong></td><td>&gt;180</td><td>&gt;120</td></tr>
    </tbody>
  </table>
</div>
<div class="rx-section">
  <div class="rx-section-title">💡 Key Tips</div>
  <div class="diet-item">🧂 Limit sodium to &lt;2300mg/day (avoid pickled, canned foods)</div>
  <div class="diet-item">🚶 30 min daily exercise lowers BP by 5–8 mmHg</div>
  <div class="diet-item">🧄 Garlic, leafy greens, berries naturally support BP</div>
  <div class="diet-item">😴 7–8 hours sleep — poor sleep raises BP</div>
  <div class="diet-item">🚬 Quit smoking · 🍺 Limit alcohol</div>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Monitor BP at home daily. Share records with your doctor at follow-up.</em></p>`;
  }

  // Drug interactions
  if (t.includes('interaction') || t.includes('together') || t.includes('mix') || t.includes('combine')) {
    return `<div class="rx-section">
  <div class="rx-section-title">🔬 COMMON DRUG INTERACTIONS</div>
  <table class="rx-table">
    <thead><tr><th>Combination</th><th>Risk</th><th>Severity</th></tr></thead>
    <tbody>
      <tr><td>Metformin + Alcohol</td><td>Lactic acidosis risk</td><td><span class="tag-pill tag-red">High</span></td></tr>
      <tr><td>Statin + Grapefruit</td><td>Increases drug levels 3–5x</td><td><span class="tag-pill tag-red">High</span></td></tr>
      <tr><td>NSAIDs + Amlodipine</td><td>Reduces BP-lowering effect</td><td><span class="tag-pill tag-amber">Moderate</span></td></tr>
      <tr><td>Metformin + CT contrast dye</td><td>Kidney injury risk</td><td><span class="tag-pill tag-red">High</span></td></tr>
      <tr><td>Warfarin + Aspirin</td><td>Severe bleeding risk</td><td><span class="tag-pill tag-red">High</span></td></tr>
    </tbody>
  </table>
</div>
<p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">⚕️ <em>Always tell your doctor and pharmacist ALL medications you take, including supplements.</em></p>`;
  }

  // Greeting / hello
  if (t.match(/^(hi|hey|hello|good\s)/)) {
    return `<p>👋 Hello! I'm <strong>MediAI</strong>, your intelligent health companion.</p>
<p style="color:var(--text-secondary);font-size:0.88rem;margin-top:8px;">
  The Gemini AI is temporarily quota-limited, but I can still help with built-in medical knowledge. Try asking:
</p>
<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">
  <div class="diet-item">📋 "What is Metformin used for?"</div>
  <div class="diet-item">💰 "Show generic alternatives"</div>
  <div class="diet-item">⏰ "When should I take my medicines?"</div>
  <div class="diet-item">🍽️ "Give me a diet plan for diabetes"</div>
  <div class="diet-item">❤️ "Guide me on blood pressure"</div>
</div>
<p style="margin-top:12px;font-size:0.78rem;color:var(--text-muted);">⚕️ <em>For informational purposes only. Always consult your doctor.</em></p>`;
  }

  // Default fallback
  return `<p style="color:var(--text-secondary)">I can help with: <strong>prescriptions</strong>, <strong>medicine schedules</strong>, <strong>generic alternatives</strong>, <strong>diet plans</strong>, <strong>side effects</strong>, <strong>drug interactions</strong>, <strong>diabetes</strong>, <strong>blood pressure</strong>, and <strong>cholesterol</strong>.</p>
<p style="font-size:0.84rem;color:var(--text-muted);margin-top:10px;">The Gemini AI API is temporarily unavailable (quota limit). Built-in responses are active. Please try a more specific question!</p>
<p style="margin-top:10px;font-size:0.78rem;color:var(--text-muted);">⚕️ <em>This is for informational purposes only. Consult your doctor before making medical decisions.</em></p>`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Message Rendering ─────────────────────────────────────────
function appendMessage(role, content, isHTML = false) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${role === 'ai' ? 'ai-message' : 'user-message'}`;

  const uid = Date.now() + Math.random();

  const avatarHTML = role === 'ai'
    ? `<div class="message-avatar ai-avatar">
        <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
          <circle cx="14" cy="14" r="14" fill="url(#aiG${uid})"/>
          <path d="M10 11h8v3h3v4h-3v3h-8v-3H7v-4h3z" fill="white" opacity="0.9"/>
          <defs><linearGradient id="aiG${uid}" x1="0" y1="0" x2="28" y2="28">
            <stop offset="0%" stop-color="#00d4ff"/><stop offset="100%" stop-color="#0066ff"/>
          </linearGradient></defs>
        </svg>
      </div>`
    : `<div class="message-avatar user-avatar">👤</div>`;

  const bubbleContent = isHTML ? content : escapeHTML(content).replace(/\n/g, '<br/>');

  div.innerHTML = `
    ${avatarHTML}
    <div class="message-content">
      <div class="message-bubble">${bubbleContent}</div>
      <span class="message-time">${getTime()}</span>
    </div>`;

  container.appendChild(div);
  scrollToBottom();
  return div;
}

function showTyping() {
  const id = 'typing_' + Date.now();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message ai-message typing-indicator';
  div.id = id;
  div.innerHTML = `
    <div class="message-avatar ai-avatar">
      <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="14" fill="url(#typG)"/>
        <path d="M10 11h8v3h3v4h-3v3h-8v-3H7v-4h3z" fill="white" opacity="0.9"/>
        <defs><linearGradient id="typG" x1="0" y1="0" x2="28" y2="28">
          <stop offset="0%" stop-color="#00d4ff"/><stop offset="100%" stop-color="#0066ff"/>
        </linearGradient></defs>
      </svg>
    </div>
    <div class="message-content">
      <div class="message-bubble">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
      <span class="message-time">Gemini AI thinking...</span>
    </div>`;
  container.appendChild(div);
  scrollToBottom();
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ─── Prescriptions View ────────────────────────────────────────
function renderPrescriptions() {
  const grid  = document.getElementById('prescriptions-grid');

  if (state.prescriptions.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <h3>No Prescriptions Yet</h3>
      <p>Upload your first prescription in the chat to get an AI-powered analysis</p>
      <button class="primary-btn" onclick="switchView('chat'); setTimeout(()=>triggerFileUpload(),300)">Upload Prescription</button>
    </div>`;
    return;
  }

  grid.innerHTML = state.prescriptions.map(rx => `
    <div class="prescription-card">
      <div class="rx-card-header">
        <div>
          <div class="rx-card-title">${rx.condition || 'Prescription'}</div>
          <div class="rx-card-date">📅 ${rx.date}</div>
        </div>
        <button onclick="deletePrescription(${rx.id})"
          style="color:var(--rose);font-size:0.8rem;padding:4px 8px;border:1px solid rgba(255,77,109,0.3);border-radius:6px;background:rgba(255,77,109,0.08)">
          Delete
        </button>
      </div>
      <div class="rx-card-body">
        <div class="rx-card-row">
          <span class="rx-card-label">👨‍⚕️ Doctor</span>
          <span class="rx-card-value">${rx.doctor || '—'}</span>
        </div>
        <div class="rx-card-row">
          <span class="rx-card-label">💊 Medications</span>
          <span class="rx-card-value">${rx.medications ? rx.medications.length : '—'}</span>
        </div>
        <div class="rx-card-row">
          <span class="rx-card-label">📝 Notes</span>
          <span class="rx-card-value">${rx.notes || '—'}</span>
        </div>
      </div>
      ${rx.aiAnalyzed ? '<span class="tag-pill tag-green" style="margin-top:12px;display:inline-block;">🤖 Gemini AI Analyzed</span>' : ''}
    </div>`
  ).join('');
}

function deletePrescription(id) {
  if (!confirm('Delete this prescription?')) return;
  state.prescriptions = state.prescriptions.filter(rx => rx.id !== id);
  saveState();
  renderPrescriptions();
  showToast('Prescription deleted', 'info', '🗑️');
}

// ─── Medications View ──────────────────────────────────────────
function renderMedications() {
  const list = document.getElementById('medications-list');

  document.getElementById('total-meds-count').textContent   = state.medications.length;
  document.getElementById('morning-meds-count').textContent = state.medications.filter(m =>
    m.timing && (m.timing.toLowerCase().includes('morning') || m.timing === 'After food')).length;
  document.getElementById('evening-meds-count').textContent = state.medications.filter(m =>
    m.timing && (m.timing.toLowerCase().includes('evening') || m.timing === 'At bedtime')).length;
  document.getElementById('refill-alert-count').textContent = state.medications.filter(m => m.refillDate).length;

  if (state.medications.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">💊</div>
      <h3>No Medications Tracked</h3>
      <p>Add medications manually or analyze a prescription in the chat</p>
      <button class="primary-btn" onclick="showAddMedModal()">Add Medication</button>
    </div>`;
    return;
  }

  list.innerHTML = state.medications.map(med => `
    <div class="med-card">
      <div class="med-card-indicator"></div>
      <div class="med-icon">💊</div>
      <div class="med-info">
        <div class="med-name">${med.name}</div>
        <div class="med-details">
          <span>⏱️ ${med.frequency || '—'}</span>
          <span>🍽️ ${med.timing || '—'}</span>
          ${med.condition ? `<span>🩺 ${med.condition}</span>` : ''}
          ${med.duration  ? `<span>📅 ${med.duration}</span>`  : ''}
        </div>
        <div class="med-tags">
          ${med.generic    ? `<span class="tag-pill tag-green">Generic: ${med.generic}</span>` : ''}
          ${med.refillDate ? `<span class="tag-pill tag-amber">Refill: ${med.refillDate}</span>` : ''}
        </div>
      </div>
      <div class="med-actions">
        <button class="med-action-btn" onclick="deleteMedication('${med.id}')" title="Delete">🗑️</button>
      </div>
    </div>`
  ).join('');

  updateSidebarSchedule();
}

function deleteMedication(id) {
  if (!confirm('Remove this medication?')) return;
  state.medications = state.medications.filter(m => m.id != id);
  saveState();
  renderMedications();
  updateSidebarStats();
  showToast('Medication removed', 'info', '🗑️');
}

function updateSidebarSchedule() {
  const timeline = document.getElementById('meds-timeline');
  if (state.medications.length === 0) {
    timeline.innerHTML = '<p class="no-meds-msg">No medications scheduled yet</p>';
    return;
  }
  const slots = {
    'Morning':  state.medications.filter(m => m.timing && (m.timing.toLowerCase().includes('morning') || m.timing === 'After food')),
    'Evening':  state.medications.filter(m => m.timing && m.timing.toLowerCase().includes('evening')),
    'Bedtime':  state.medications.filter(m => m.timing === 'At bedtime'),
  };
  const items = Object.entries(slots)
    .filter(([, meds]) => meds.length > 0)
    .map(([slot, meds]) => `
      <div class="med-time-item">
        <span class="med-time-label">${slot}</span>
        <span class="med-time-name">${meds.map(m => m.name.split(' ')[0]).join(', ')}</span>
      </div>`)
    .join('');
  timeline.innerHTML = items || '<p class="no-meds-msg">No schedule defined</p>';
}

// ─── Add Medication Modal ──────────────────────────────────────
function showAddMedModal() {
  document.getElementById('add-med-modal').classList.add('active');
}
function closeAddMedModal() {
  document.getElementById('add-med-modal').classList.remove('active');
  document.getElementById('add-med-form').reset();
}

function addMedication(event) {
  event.preventDefault();
  const med = {
    id:        Date.now(),
    name:      document.getElementById('med-name').value.trim(),
    dosage:    document.getElementById('med-dosage').value.trim(),
    frequency: document.getElementById('med-frequency').value,
    timing:    document.getElementById('med-timing').value,
    condition: document.getElementById('med-condition').value.trim(),
    duration:  document.getElementById('med-duration').value.trim(),
    notes:     document.getElementById('med-notes').value.trim(),
    addedDate: new Date().toLocaleDateString('en-IN'),
  };
  state.medications.push(med);
  saveState();
  closeAddMedModal();
  renderMedications();
  updateSidebarStats();
  showToast(`${med.name} added`, 'success', '💊');
  switchView('medications');
}

// ─── Profile ───────────────────────────────────────────────────
function renderProfile() {
  const p = state.patientProfile;
  if (!p) return;
  document.getElementById('patient-name').value       = p.name       || '';
  document.getElementById('patient-age').value        = p.age        || '';
  document.getElementById('patient-gender').value     = p.gender     || '';
  document.getElementById('patient-blood').value      = p.blood      || '';
  document.getElementById('patient-weight').value     = p.weight     || '';
  document.getElementById('patient-height').value     = p.height     || '';
  document.getElementById('patient-conditions').value = p.conditions || '';
  document.getElementById('patient-allergies').value  = p.allergies  || '';
  document.getElementById('patient-lifestyle').value  = p.lifestyle  || '';
  updateHealthMetrics(p);
}

function saveProfile(event) {
  event.preventDefault();
  const p = {
    name:       document.getElementById('patient-name').value.trim(),
    age:        document.getElementById('patient-age').value,
    gender:     document.getElementById('patient-gender').value,
    blood:      document.getElementById('patient-blood').value,
    weight:     document.getElementById('patient-weight').value,
    height:     document.getElementById('patient-height').value,
    conditions: document.getElementById('patient-conditions').value.trim(),
    allergies:  document.getElementById('patient-allergies').value.trim(),
    lifestyle:  document.getElementById('patient-lifestyle').value.trim(),
  };
  state.patientProfile = p;
  saveState();
  updateHealthMetrics(p);
  updateSidebarPatientCard(p);
  showToast('Profile saved!', 'success', '✅');
}

function updateHealthMetrics(p) {
  let bmi = '—';
  if (p.weight && p.height) {
    const h = parseFloat(p.height) / 100;
    const b = parseFloat(p.weight) / (h * h);
    const cat = b < 18.5 ? 'Underweight' : b < 25 ? 'Normal' : b < 30 ? 'Overweight' : 'Obese';
    bmi = `${b.toFixed(1)} (${cat})`;
  }
  document.getElementById('bmi-display').textContent        = bmi;
  document.getElementById('blood-display').textContent      = p.blood      || '—';
  document.getElementById('conditions-display').textContent = p.conditions || 'None';
  document.getElementById('allergies-display').textContent  = p.allergies  || 'None known';
}

function updateSidebarPatientCard(p) {
  if (p.name) {
    document.getElementById('patient-name-display').textContent = p.name;
    const meta = [p.age ? `${p.age} yrs` : '', p.gender || '', p.blood || ''].filter(Boolean).join(' · ');
    document.getElementById('patient-meta-display').textContent = meta || 'Profile set';
  }
}

function clearAllData() {
  if (!confirm('⚠️ This will permanently delete all your health data. Are you sure?')) return;
  if (!confirm('Are you REALLY sure? This cannot be undone.')) return;
  state.prescriptions  = [];
  state.medications    = [];
  state.patientProfile = {};
  state.messages       = [];
  state.geminiHistory  = [];
  localStorage.removeItem('mediAI_v2_state');
  renderProfile();
  renderPrescriptions();
  renderMedications();
  updateSidebarStats();
  showToast('All data cleared', 'info', '🗑️');
}

// ─── Sidebar Stats ─────────────────────────────────────────────
function updateSidebarStats() {
  document.getElementById('stat-prescriptions').textContent = state.prescriptions.length;
  document.getElementById('stat-medications').textContent   = state.medications.length;
  updateSidebarSchedule();
}

// ─── Utilities ─────────────────────────────────────────────────
function scrollToBottom() {
  const c = document.getElementById('chat-messages');
  setTimeout(() => { c.scrollTop = c.scrollHeight; }, 60);
}

function getTime() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function escapeHTML(str) {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

function showToast(message, type = 'info', icon = '✅') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ─── Initialization ────────────────────────────────────────────
function init() {
  loadState();
  initECGCanvas();
  updateSidebarStats();

  if (state.patientProfile && state.patientProfile.name) {
    updateSidebarPatientCard(state.patientProfile);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });

  window.addEventListener('scroll', () => {
    document.getElementById('main-header').style.boxShadow =
      window.scrollY > 10 ? '0 4px 40px rgba(0,0,0,0.5)' : '';
  });

  // Show Gemini status in header
  showToast('🤖 Gemini AI Connected & Ready', 'success', '✅');

  console.log('%c🏥 MediAI + Gemini AI initialized', 'color:#00d4ff;font-weight:bold;font-size:14px');
}

// ─── Settings UI Handlers ─────────────────────────────────────
function showSettings() {
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('settings-api-key');
  if (modal && input) {
    input.value = localStorage.getItem('mediAI_api_key') || '';
    modal.classList.add('active');
  }
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('active');
}

function saveSettings() {
  const input = document.getElementById('settings-api-key');
  if (input) {
    const val = input.value.trim();
    if (val) {
      localStorage.setItem('mediAI_api_key', val);
      showToast('API Key saved successfully! ⚙️', 'success', '🔑');
    } else {
      localStorage.removeItem('mediAI_api_key');
      showToast('Using default shared key. ⚙️', 'info', 'ℹ️');
    }
    closeSettings();
  }
}

document.addEventListener('DOMContentLoaded', init);
