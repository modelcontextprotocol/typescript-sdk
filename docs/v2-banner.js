document.addEventListener("DOMContentLoaded", function () {
    var banner = document.createElement("div");
    banner.innerHTML =
        "This documents a <strong>pre-release</strong> version of the SDK. Expect breaking changes. For the stable SDK, see the <a href='/typescript-sdk/'>V1 docs</a>.";
    banner.style.cssText =
        "background:#fff3cd;color:#856404;border-bottom:1px solid #ffc107;padding:8px 16px;text-align:center;font-size:14px;";
    banner.querySelector("a").style.cssText = "color:#856404;text-decoration:underline;";
    document.body.insertBefore(banner, document.body.firstChild);
});
