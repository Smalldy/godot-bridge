(function () {
  const menuBtn = document.getElementById('menuBtn');
  const navLinks = document.getElementById('navLinks');
  if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', function () {
      const open = navLinks.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    navLinks.addEventListener('click', function (event) {
      if (event.target && event.target.tagName === 'A') {
        navLinks.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const copyBtn = document.getElementById('copyBtn');
  const installCmd = document.getElementById('installCmd');
  if (copyBtn && installCmd) {
    copyBtn.addEventListener('click', async function () {
      const text = installCmd.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '已复制';
      } catch (error) {
        const range = document.createRange();
        range.selectNodeContents(installCmd);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copyBtn.textContent = '已选中';
      }
      setTimeout(function () { copyBtn.textContent = '复制'; }, 1600);
    });
  }

  const reveal = document.querySelectorAll('.section, .cta');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    reveal.forEach(function (el) { el.classList.add('reveal'); io.observe(el); });
  }
})();