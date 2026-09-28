// 🎛️ Modal UI Elements Connection
const authModal = document.getElementById('auth-modal');
const closeModal = document.getElementById('close-modal');
const navRegisterBtn = document.getElementById('nav-register-btn');

// Register button click par popup open karna
if (navRegisterBtn && authModal) {
  navRegisterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    authModal.style.display = 'flex';
  });
}

// X click par popup close karna
if (closeModal && authModal) {
  closeModal.addEventListener('click', () => {
    authModal.style.display = 'none';
  });
}

// 🚀 Safe Data Registration Request
const regBtn = document.getElementById('reg-btn');

if (regBtn) {
  regBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    // Elements check
    const nameEl = document.getElementById('reg-name');
    const emailEl = document.getElementById('reg-email');
    const passwordEl = document.getElementById('reg-password');

    if (!nameEl || !emailEl || !passwordEl) {
      alert('⚠️ System Error: HTML input fields are not matching code IDs!');
      return;
    }

    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passwordEl.value;

    if (!name || !email || !password) {
      alert('Please fill all required fields!');
      return;
    }

    try {
      // Direct Local Numerical IP (Bypassing network timeouts)
      const response = await fetch('http://127.0.0', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ name, email, password, role: 'customer' })
      });

      const data = await response.json();

      if (response.ok) {
        alert('🚀 ShopVioMall: Account Created Successfully in Database!');
        if (authModal) authModal.style.display = 'none';
      } else {
        alert('❌ Database Error: ' + data.message);
      }

    } catch (err) {
      console.error(err);
      alert('❌ Server Connection Error. Please verify your backend server status.');
    }
  });
}
