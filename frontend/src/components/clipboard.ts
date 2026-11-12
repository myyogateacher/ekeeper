import { toast } from "react-toastify";

/**
 * The one copy action. navigator.clipboard exists only in a secure context, so on a plain http deploy the
 * write rejects; the toast says so instead of the click doing nothing.
 */
export async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.info(successMessage);
  } catch {
    toast.error("Couldn't copy. The clipboard needs HTTPS, so copy it by hand.");
  }
}
