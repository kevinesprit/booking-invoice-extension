// Booking Invoice — Content Script
// Scrapes Booking.com reservation pages and sends data to local server.

(function () {
  'use strict';

  // Don't inject twice
  if (document.getElementById('booking-invoice-btn')) return;

  // ── Scraping ─────────────────────────────────────────────────────

  function extractData() {
    const data = {};

    // Try to extract from the page using multiple strategies

    // --- Reservation number ---
    // Strategy 1: Look for elements containing "confirmation" or "réservation"
    const numSelectors = [
      '[data-testid="reservation-number"]',
      '.confirmation-number',
      '.reservation-number',
      '[class*="confirmation"] strong',
      '[class*="reservation"] strong'
    ];
    for (const sel of numSelectors) {
      const el = document.querySelector(sel);
      if (el) { data.booking_ref = el.textContent.trim(); break; }
    }
    // Strategy 2: Parse from URL: /reservation/... or ?label=...
    if (!data.booking_ref) {
      const m = window.location.href.match(/(?:reservation|confirmation)[=/]([^?&]+)/i);
      if (m) data.booking_ref = m[1];
    }
    // Strategy 3: Look for any bold number near "N°" or "#"
    if (!data.booking_ref) {
      const all = document.body.innerText;
      const m = all.match(/(?:n[°º]|#)\s*(\d{6,12})/i);
      if (m) data.booking_ref = m[1];
    }

    // --- Guest name ---
    const guestSelectors = [
      '[data-testid="guest-name"]',
      '.guest-details .name',
      '[class*="guest"] [class*="name"]',
      'h3:contains("Client"), h4:contains("Client"), strong:contains("Client")'
    ];
    for (const sel of guestSelectors) {
      try {
        const el = document.querySelector(sel) || 
                   [...document.querySelectorAll('*')].find(e => e.textContent.includes('Client') && e.tagName.match(/H[1-6]/));
        if (el) {
          // Try to get the name from a nearby element
          const parent = el.closest('div,section,li');
          if (parent) {
            const text = parent.textContent.replace(/\s+/g, ' ').trim();
            // Extract name: after "Client" or similar, before next section
            const m = text.match(/(?:Client|Voyageur|Guest)[:\s]+([A-Z][a-zéèêëàâîïôûùç]+(?:\s+[A-Z][a-zéèêëàâîïôûùç]+)+)/i);
            if (m) { data.guest_name = m[1]; break; }
          }
        }
      } catch(e) {}
    }
    // Fallback: look for common French name patterns near guest section
    if (!data.guest_name) {
      const text = document.body.innerText;
      const m = text.match(/(?:client|voyageur|guest|réservé par)[:\s]+([A-Z][a-zéèêëàâîïôûùç]+ [A-Z][a-zéèêëàâîïôûùç]+)/i);
      if (m) data.guest_name = m[1];
    }

    // --- Property / Address ---
    const propSelectors = [
      '[data-testid="property-name"]',
      '#hp_hotel_name',
      'h1', 'h2'
    ];
    for (const sel of propSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 3 && el.textContent.trim().length < 200) {
        data.description = el.textContent.trim();
        break;
      }
    }

    // Try to find address
    const addrSelectors = [
      '[data-testid="property-address"]',
      '.hp_address_subtitle',
      '[class*="address"]'
    ];
    for (const sel of addrSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const addr = el.textContent.trim();
        if (addr.length > 5) {
          // Append address to description if not already there
          if (!data.description.includes(addr.substring(0, 10))) {
            data.description += ' — ' + addr;
          }
        }
        break;
      }
    }

    // --- Dates ---
    // Strategy 1: date inputs
    const checkinEl = document.querySelector('[data-testid="checkin-date"], [name="checkin"], #checkin, input[placeholder*="arrivée"], input[placeholder*="check-in"]');
    const checkoutEl = document.querySelector('[data-testid="checkout-date"], [name="checkout"], #checkout, input[placeholder*="départ"], input[placeholder*="check-out"]');
    if (checkinEl) data.checkin = checkinEl.value || checkinEl.textContent.trim();
    if (checkoutEl) data.checkout = checkoutEl.value || checkoutEl.textContent.trim();

    // Strategy 2: look for date patterns in the page text
    if (!data.checkin || !data.checkout) {
      const text = document.body.innerText;
      // French date format: DD/MM/YYYY or DD month YYYY
      const datePattern = /(\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4})/gi;
      const dates = text.match(datePattern);
      if (dates && dates.length >= 2) {
        if (!data.checkin) data.checkin = parseDate(dates[0]);
        if (!data.checkout) data.checkout = parseDate(dates[1]);
      }
    }

    // Strategy 3: ISO dates in page
    if (!data.checkin || !data.checkout) {
      const isoDates = document.body.innerText.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
      if (isoDates && isoDates.length >= 2) {
        if (!data.checkin) data.checkin = isoDates[0];
        if (!data.checkout) data.checkout = isoDates[1];
      }
    }

    // --- Nights ---
    if (data.checkin && data.checkout) {
      const ci = new Date(data.checkin);
      const co = new Date(data.checkout);
      if (!isNaN(ci) && !isNaN(co)) {
        data.nights = Math.round((co - ci) / (1000 * 60 * 60 * 24));
      }
    }
    if (!data.nights) {
      // Try to find in text
      const m = document.body.innerText.match(/(\d+)\s*nuit/i);
      if (m) data.nights = parseInt(m[1]);
    }

    // --- Price per night ---
    // Look for price display elements
    const priceEls = document.querySelectorAll('.bui-price-display__value, [class*="price"] [class*="value"], [class*="amount"]');
    const prices = [];
    for (const el of priceEls) {
      const t = el.textContent.trim();
      const m = t.match(/[\d\s,.]+/);
      if (m) {
        const val = parseFloat(m[0].replace(/\s/g, '').replace(',', '.'));
        if (val > 1 && val < 10000) prices.push(val);
      }
    }
    if (prices.length > 0) {
      // The largest price is usually the total, medium is per night
      prices.sort((a,b) => a-b);
      data.rate_per_night = prices[0]; // Smallest is usually per-night
    }

    // --- Tourist tax ---
    const taxMatch = document.body.innerText.match(/(?:taxe\s*(?:de\s*)?s[ée]jour|tourist\s*tax)[:\s]*([\d\s,.]+)\s*[€$]/i);
    if (taxMatch) {
      data.taxe_sejour = parseFloat(taxMatch[1].replace(/\s/g, '').replace(',', '.'));
    }

    // --- Total TTC ---
    const totalSelectors = ['.bui-price-display__value', '[class*="total"] [class*="price"]'];
    for (const sel of totalSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const m = el.textContent.match(/[\d\s,.]+/);
        if (m) {
          const val = parseFloat(m[0].replace(/\s/g, '').replace(',', '.'));
          if (val > 10 && (!data.rate_per_night || val > data.rate_per_night)) {
            // Store total for reference
            data.total_ttc = val;
          }
        }
      }
    }

    // --- TVA ---
    // Default to 10% for French seasonal rentals
    data.tva_rate = 10;
    // Try to find VAT info
    const tvaMatch = document.body.innerText.match(/(?:TVA|VAT)[:\s]*(\d+[\.,]?\d*)\s*%/i);
    if (tvaMatch) data.tva_rate = parseFloat(tvaMatch[1].replace(',', '.'));

    // --- Payment method ---
    data.payment_method = 'Réservation Booking.com';

    // --- Issue date ---
    const today = new Date();
    data.issue_date = today.toISOString().split('T')[0];

    return data;
  }

  function parseDate(text) {
    const months = {
      'janvier': '01', 'février': '02', 'mars': '03', 'avril': '04',
      'mai': '05', 'juin': '06', 'juillet': '07', 'août': '08',
      'septembre': '09', 'octobre': '10', 'novembre': '11', 'décembre': '12',
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'may': '05',
      'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10',
      'nov': '11', 'dec': '12'
    };
    text = text.toLowerCase();
    for (const [name, num] of Object.entries(months)) {
      if (text.includes(name)) {
        const m = text.match(/(\d{1,2})\s+/);
        const y = text.match(/(\d{4})/);
        if (m && y) {
          return `${y[1]}-${num}-${m[1].padStart(2, '0')}`;
        }
      }
    }
    return '';
  }

  // ── UI: Floating button ──────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.id = 'booking-invoice-btn';
    btn.textContent = '🧾 Facture';
    btn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #1a2d4a; color: #fff; border: none; border-radius: 12px;
      padding: 12px 20px; font-size: 15px; font-weight: 700;
      font-family: -apple-system, sans-serif; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      transition: transform 0.15s, box-shadow 0.15s;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    });
    btn.addEventListener('click', () => {
      const data = extractData();
      showPreview(data);
    });
    document.body.appendChild(btn);
  }

  // ── Send to server ──────────────────────────────────────────────

  function showPreview(data) {
    // Build URL with query params for the server
    const params = new URLSearchParams();
    if (data.booking_ref) params.set('booking_ref', data.booking_ref);
    if (data.guest_name) params.set('guest_name', data.guest_name);
    if (data.checkin) params.set('checkin', data.checkin);
    if (data.checkout) params.set('checkout', data.checkout);
    if (data.nights) params.set('nights', String(data.nights));
    if (data.description) params.set('description', data.description);
    if (data.rate_per_night) params.set('rate_per_night', String(data.rate_per_night));
    if (data.taxe_sejour) params.set('taxe_sejour', String(data.taxe_sejour));
    if (data.tva_rate) params.set('tva_rate', String(data.tva_rate));
    if (data.issue_date) params.set('issue_date', data.issue_date);
    if (data.payment_method) params.set('payment_method', data.payment_method);

    // Open preview in new tab
    const url = `http://localhost:5042/api/invoice?${params.toString()}`;
    window.open(url, '_blank');
  }

  // ── Also expose for popup ──────────────────────────────────────

  // Listen for messages from popup
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'scrape') {
      sendResponse(extractData());
    }
    return true;
  });

  // ── Init ────────────────────────────────────────────────────────
  createButton();

})();
