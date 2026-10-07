/** Short owner-facing descriptions; no command arguments or model reasoning. */
export function describeToolActivity(name: string): string {
  const labels: Record<string, string> = {
    desktop_app: "Opening an application",
    desktop_observe: "Checking the screen",
    desktop_windows: "Checking open windows",
    desktop_wait: "Waiting for the screen to update",
    system_exec: "Running a command on your PC",
    system_read: "Reading a file",
    system_write: "Writing a file",
    system_list: "Checking files",
    request_owner_input: "Waiting for your answer",
    telegram_send_image: "Sending you an image",
    telegram_send_file: "Sending you a file",
  };
  return labels[name] ?? (name.startsWith("browser_") ? "Using Chrome" : name.startsWith("desktop_") ? "Using the desktop" : "Executing the next step");
}
