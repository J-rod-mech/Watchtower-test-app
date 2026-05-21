(function (global) {
  "use strict";

  var DEFAULT_ENDPOINT = "http://localhost:8000/api/events";
  var FLUSH_INTERVAL = 2000;
  var SESSION_KEY = "__wt_sid";
  var DEFAULT_CLICK_SELECTOR = ".btn, .card, .nav-links a, [data-wt-click]";
  var inMemorySessionId = null;
  var fallbackSessionCounter = 0;

  function generateId() {
    var cryptoObj = global.crypto || global.msCrypto;
    var bytes = new Uint8Array(12);
    var index = 0;

    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(bytes);
      return "xxxxxxxx-xxxx-4xxx".replace(/x/g, function () {
        var value = bytes[index++] & 0x0f;
        return value.toString(16);
      });
    }

    fallbackSessionCounter += 1;
    return ["fallback", Date.now().toString(16), fallbackSessionCounter.toString(16)].join("-");
  }

  function readSessionValue(key) {
    try {
      if (!global.sessionStorage) return null;
      return global.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function writeSessionValue(key, value) {
    try {
      if (global.sessionStorage) global.sessionStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function getSessionId() {
    var sessionId = readSessionValue(SESSION_KEY) || inMemorySessionId;
    if (!sessionId) {
      sessionId = generateId();
      inMemorySessionId = sessionId;
      writeSessionValue(SESSION_KEY, sessionId);
    }
    return sessionId;
  }

  function getText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function elementSelectorHint(element) {
    if (!element || !element.tagName) return "unknown";
    var base = element.tagName.toLowerCase();
    if (element.id) return base + "#" + element.id;
    if (element.className && typeof element.className === "string") {
      var firstClass = element.className.split(/\s+/).filter(Boolean)[0];
      if (firstClass) return base + "." + firstClass;
    }
    return base;
  }

  function WatchTower(config) {
    config = config || {};
    this.endpoint = config.endpoint || DEFAULT_ENDPOINT;
    this.deployVersion = config.deployVersion || "unknown";
    this.appName = config.appName || location.hostname;
    this.userId = config.userId || null;
    this.sessionId = getSessionId();
    this.clickSelector = config.clickSelector || DEFAULT_CLICK_SELECTOR;
    this._queue = [];
    this._flushing = false;
    this._wrappedFunctions = {};
    this._bridgeObserver = null;

    this._bindErrors();
    this._bindPerformance();
    this._bindAutoClicks();
    this._bindAppBridge();
    this._bindDomHeuristics();
    this._bindFunctionHeuristics();
    this._startFlush();
  }

  WatchTower.prototype.setUser = function (userId) {
    this.userId = userId || null;
  };

  WatchTower.prototype.setDeployVersion = function (deployVersion) {
    this.deployVersion = deployVersion || "unknown";
  };

  WatchTower.prototype._enqueue = function (type, data) {
    this._queue.push({
      type: type,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      userId: this.userId,
      deployVersion: this.deployVersion,
      appName: this.appName,
      url: location.href,
      route: location.pathname,
      data: data || {},
    });
  };

  WatchTower.prototype.trackClick = function (target, text) {
    this._enqueue("click", {
      target: target || "",
      text: (text || "").substring(0, 100),
    });
  };

  WatchTower.prototype.trackEvent = function (name, payload) {
    this._enqueue("custom", {
      name: name,
      payload: payload || {},
    });
  };

  WatchTower.prototype.trackError = function (errorLike) {
    var message = "Unknown error";
    var stack = "";

    if (errorLike && typeof errorLike === "object") {
      message = errorLike.message || String(errorLike);
      stack = errorLike.stack || "";
    } else if (errorLike != null) {
      message = String(errorLike);
    }

    this._enqueue("error", {
      message: message,
      source: "manual",
      line: 0,
      col: 0,
      stack: stack,
    });
  };

  WatchTower.prototype._flush = function () {
    if (this._flushing || this._queue.length === 0) return;

    this._flushing = true;
    var batch = this._queue.splice(0, 50);
    var self = this;

    fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    })
      .catch(function () {
        self._queue = batch.concat(self._queue);
      })
      .finally(function () {
        self._flushing = false;
      });
  };

  WatchTower.prototype._startFlush = function () {
    var self = this;

    setInterval(function () {
      self._flush();
    }, FLUSH_INTERVAL);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") self._flush();
    });
  };

  WatchTower.prototype._bindErrors = function () {
    var self = this;

    global.addEventListener("error", function (event) {
      self._enqueue("error", {
        message: event.message || "Unknown error",
        source: event.filename || "",
        line: event.lineno || 0,
        col: event.colno || 0,
        stack: event.error ? event.error.stack || "" : "",
      });
    });

    global.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason || {};
      self._enqueue("error", {
        message: reason.message || String(reason),
        source: "unhandledrejection",
        line: 0,
        col: 0,
        stack: reason.stack || "",
      });
    });
  };

  WatchTower.prototype._bindPerformance = function () {
    var self = this;

    global.addEventListener("load", function () {
      setTimeout(function () {
        var nav = performance.getEntriesByType("navigation")[0];
        if (!nav) return;

        self._enqueue("pageload", {
          duration: Math.round(nav.duration),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          loadComplete: Math.round(nav.loadEventEnd - nav.startTime),
          transferSize: nav.transferSize || 0,
        });
      }, 100);
    });
  };

  WatchTower.prototype._bindAutoClicks = function () {
    var self = this;

    document.addEventListener("click", function (event) {
      var matched = event.target && event.target.closest ? event.target.closest(self.clickSelector) : null;
      if (!matched) return;

      var explicitTarget = matched.getAttribute("data-wt-target") || "";
      var target = explicitTarget || elementSelectorHint(matched);
      var text = matched.getAttribute("data-wt-text") || getText(matched.textContent || matched.innerText || "");
      self.trackClick(target, text.substring(0, 100));
    });
  };

  WatchTower.prototype._bindAppBridge = function () {
    var self = this;

    function bindEventAliases(eventNames, handler) {
      eventNames.forEach(function (eventName) {
        global.addEventListener(eventName, handler);
      });
    }

    bindEventAliases(["app:user", "watchtower:user"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      self.setUser(detail.userId || null);
    });

    bindEventAliases(["app:version", "watchtower:version"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      self.setDeployVersion(detail.deployVersion || detail.version || "unknown");
      self.trackEvent("version-switch", { version: self.deployVersion });
    });

    bindEventAliases(["app:event", "watchtower:event"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      var eventName = detail.name || "app-event";
      self.trackEvent(eventName, detail.payload || {});
    });

    bindEventAliases(["app:feedback", "watchtower:feedback"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      self._enqueue("feedback", {
        rating: Number(detail.rating) || 0,
        message: detail.message || "",
        category: detail.category || "general",
      });
    });

    bindEventAliases(["app:pageload", "watchtower:pageload"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      self._enqueue("pageload", {
        duration: Number(detail.duration) || 0,
        ttfb: Number(detail.ttfb) || 0,
        domContentLoaded: Number(detail.domContentLoaded) || 0,
        loadComplete: Number(detail.loadComplete) || 0,
        transferSize: Number(detail.transferSize) || 0,
      });
    });

    bindEventAliases(["app:error", "watchtower:error"], function (event) {
      var detail = event && event.detail ? event.detail : {};
      self.trackError(detail.error || detail.message || "Manual app error");
    });
  };

  WatchTower.prototype._bindDomHeuristics = function () {
    var self = this;
    var versionSelect = document.getElementById("version-select");
    if (versionSelect && !versionSelect.__wtBound) {
      versionSelect.__wtBound = true;
      self.setDeployVersion(versionSelect.value || "unknown");
      versionSelect.addEventListener("change", function () {
        self.setDeployVersion(versionSelect.value || "unknown");
        self.trackEvent("version-switch", { version: self.deployVersion, source: "dom-heuristic" });
      });
    }
  };

  WatchTower.prototype._bindFunctionHeuristics = function () {
    var self = this;

    function safeWrap(functionName, afterCall) {
      if (self._wrappedFunctions[functionName]) return;
      var original = global[functionName];
      if (typeof original !== "function") return;

      global[functionName] = function () {
        var args = Array.prototype.slice.call(arguments);
        var result = original.apply(this, args);
        try {
          afterCall(args, result);
        } catch (_error) {
          // Ignore heuristic capture failures.
        }
        return result;
      };
      self._wrappedFunctions[functionName] = true;
    }

    function bindKnownFunctions() {
      safeWrap("__triggerCustomEvent", function () {
        self.trackEvent("custom-demo-action", { source: "function-hook" });
      });

      safeWrap("__triggerSlowLoad", function () {
        self.trackEvent("slow-load-simulated", { source: "function-hook" });
      });

      safeWrap("__addToCart", function (args) {
        self.trackEvent("add-to-cart", {
          productId: Number(args[0]) || null,
          source: "function-hook",
        });
      });

      safeWrap("__removeFromCart", function (args) {
        self.trackEvent("remove-from-cart", {
          cartIndex: Number(args[0]) || 0,
          source: "function-hook",
        });
      });

      safeWrap("__checkout", function () {
        self.trackEvent("checkout-success", { source: "function-hook" });
      });

      safeWrap("__checkoutError", function () {
        self.trackEvent("checkout-error-flow", { source: "function-hook" });
      });

      safeWrap("__login", function () {
        var userBadge = document.getElementById("user-badge");
        var username = userBadge ? getText(userBadge.textContent || "") : "";
        var isVisible = userBadge && !userBadge.classList.contains("hidden");
        if (!isVisible || !username) return;

        self.setUser(username);
        self._enqueue("login", {
          userId: username,
          source: "function-hook",
        });
      });

      safeWrap("__logout", function () {
        self.setUser(null);
        self.trackEvent("logout", { source: "function-hook" });
      });
    }

    bindKnownFunctions();
    if (this._bridgeObserver) return;

    var observer = new MutationObserver(function () {
      bindKnownFunctions();
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    this._bridgeObserver = observer;
  };

  function autoInitialize() {
    var config = global.WATCHTOWER_CONFIG || {};
    var sdkInstance = new WatchTower(config);
    global.__watchTowerInstance = sdkInstance;
  }

  global.WatchTower = WatchTower;
  autoInitialize();
})(window);
