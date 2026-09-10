export function focusInvalidField(form: HTMLFormElement | null) {
  const fields = form?.querySelectorAll<HTMLElement>('[aria-invalid="true"]');
  if (!fields?.length) return;
  for (const field of fields) {
    let section = field.closest("details");
    while (section) {
      section.open = true;
      section = section.parentElement?.closest("details") ?? null;
    }
  }
  fields[0]?.focus();
}
