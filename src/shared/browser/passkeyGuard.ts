export const PASSKEY_NOTICE_PREFIX = '[ostia-passkey-unsupported]'

export const PASSKEY_GUARD_JS = `(() => {
  if (window.__ostiaPasskeyGuard) return;
  window.__ostiaPasskeyGuard = true;
  var proto = navigator.credentials && Object.getPrototypeOf(navigator.credentials);
  if (!proto) return;
  var noticed = false;

  function onlyLocalTransports(transports) {
    if (!transports || !transports.length) return false;
    return Array.prototype.every.call(transports, function (t) {
      return t === 'internal' || t === 'hybrid';
    });
  }

  function blockedCreate(options) {
    var selection = options.publicKey && options.publicKey.authenticatorSelection;
    return !!selection && selection.authenticatorAttachment === 'platform';
  }

  function blockedGet(options) {
    if (options.mediation === 'conditional') return false;
    var allowed = options.publicKey && options.publicKey.allowCredentials;
    if (!allowed || !allowed.length) return false;
    return Array.prototype.every.call(allowed, function (cred) {
      return !!cred && onlyLocalTransports(cred.transports);
    });
  }

  function refuse() {
    if (!noticed) {
      noticed = true;
      try { console.info('${PASSKEY_NOTICE_PREFIX}'); } catch (e) {}
    }
    return Promise.reject(
      new DOMException('Passkeys are not supported in this browser.', 'NotAllowedError'),
    );
  }

  function wrap(name, blocked) {
    var original = proto[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function (options) {
        if (options && options.publicKey && blocked(options)) return refuse();
        return original.apply(this, arguments);
      },
    });
  }

  wrap('create', blockedCreate);
  wrap('get', blockedGet);

  var PKC = window.PublicKeyCredential;
  if (PKC && typeof PKC.getClientCapabilities === 'function') {
    var capabilities = PKC.getClientCapabilities;
    Object.defineProperty(PKC, 'getClientCapabilities', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function () {
        return capabilities.apply(this, arguments).then(function (caps) {
          var out = Object.assign({}, caps);
          out.passkeyPlatformAuthenticator = false;
          out.hybridTransport = false;
          out.userVerifyingPlatformAuthenticator = false;
          return out;
        });
      },
    });
  }
})();`
