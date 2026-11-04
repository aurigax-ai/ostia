const LOGIN_FIELDS_JS: &str = r#"function loginFields() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
  };
  const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
  if (!password) return { password: null, user: null };
  const scope = password.form ?? document;
  const inputs = Array.from(scope.querySelectorAll("input")).filter(visible);
  const before = inputs.slice(0, inputs.indexOf(password)).reverse();
  const user = before.find((i) => i.autocomplete === "username" || i.type === "email") ?? before.find((i) => ["text", "email", "tel", ""].includes(i.type)) ?? null;
  return { password, user };
}"#;

fn quoted(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

pub fn fill_script(username: &str, password: &str) -> String {
    let username = quoted(username);
    let password = quoted(password);
    format!(
        "(() => {{
    const fields = ({LOGIN_FIELDS_JS})()
    if (!fields.password) return {{ filled: false }}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const put = (el, value) => {{
      el.focus()
      setter.call(el, value)
      el.dispatchEvent(new Event('input', {{ bubbles: true }}))
      el.dispatchEvent(new Event('change', {{ bubbles: true }}))
    }}
    if (fields.user && {username}) put(fields.user, {username})
    put(fields.password, {password})
    return {{ filled: true, user: Boolean(fields.user) }}
  }})()"
    )
}

pub fn read_script() -> String {
    format!(
        "(() => {{
    const fields = ({LOGIN_FIELDS_JS})()
    if (!fields.password || !fields.password.value) return null
    return {{ username: fields.user ? fields.user.value : '', password: fields.password.value }}
  }})()"
    )
}
