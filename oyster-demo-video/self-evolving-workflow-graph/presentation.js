const stage = document.getElementById("stage");
const slides = Array.from(document.querySelectorAll(".slide"));
const previousButton = document.getElementById("previousButton");
const playButton = document.getElementById("playButton");
const nextButton = document.getElementById("nextButton");
const timeline = document.getElementById("timeline");
const controlMeta = document.getElementById("controlMeta");
const languageButton = document.getElementById("languageButton");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let current = Number.parseInt(
  localStorage.getItem("ow-graph-demo-scene") || "0",
  10,
);
let language = localStorage.getItem("ow-graph-demo-language") || "zh";
let playing = false;
let playTimer = null;

function scaleStage() {
  const availableWidth = window.innerWidth - 24;
  const availableHeight = window.innerHeight - 108;
  const scale = Math.min(availableWidth / 1920, availableHeight / 1080);
  stage.style.setProperty("--stage-scale", String(Math.max(0.2, scale)));
}

function updateLanguage() {
  document.body.classList.toggle("lang-en", language === "en");
  document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  languageButton.textContent = language === "en" ? "中文" : "EN";
  playButton.querySelector(".zh").textContent = playing ? "暂停" : "播放";
  playButton.querySelector(".en").textContent = playing ? "Pause" : "Play";
  localStorage.setItem("ow-graph-demo-language", language);
}

function showSlide(index) {
  current = Math.max(0, Math.min(index, slides.length - 1));
  slides.forEach((slide, slideIndex) => {
    slide.classList.toggle("active", slideIndex === current);
    slide.setAttribute(
      "aria-hidden",
      slideIndex === current ? "false" : "true",
    );
  });
  timeline.value = String(current);
  controlMeta.textContent = `${String(current + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
  localStorage.setItem("ow-graph-demo-scene", String(current));
}

function stopPlayback() {
  playing = false;
  if (playTimer) window.clearInterval(playTimer);
  playTimer = null;
  updateLanguage();
}

function togglePlayback() {
  if (reduceMotion.matches) {
    showSlide(current === slides.length - 1 ? 0 : current + 1);
    return;
  }
  if (playing) {
    stopPlayback();
    return;
  }
  playing = true;
  updateLanguage();
  playTimer = window.setInterval(() => {
    if (current >= slides.length - 1) {
      stopPlayback();
      return;
    }
    showSlide(current + 1);
  }, 5200);
}

previousButton.addEventListener("click", () => {
  stopPlayback();
  showSlide(current - 1);
});
nextButton.addEventListener("click", () => {
  stopPlayback();
  showSlide(current + 1);
});
playButton.addEventListener("click", togglePlayback);
timeline.addEventListener("input", (event) => {
  stopPlayback();
  showSlide(Number.parseInt(event.target.value, 10));
});
languageButton.addEventListener("click", () => {
  language = language === "en" ? "zh" : "en";
  updateLanguage();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    stopPlayback();
    showSlide(current + 1);
  }
  if (event.key === "ArrowLeft") {
    stopPlayback();
    showSlide(current - 1);
  }
  if (event.key === " ") {
    event.preventDefault();
    togglePlayback();
  }
});
window.addEventListener("resize", scaleStage);
reduceMotion.addEventListener("change", () => {
  if (reduceMotion.matches) stopPlayback();
});

scaleStage();
showSlide(current);
updateLanguage();
