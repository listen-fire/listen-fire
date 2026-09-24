/** The one surface every settings section sits on, so the tabs read alike. */
export function Card({
  id,
  testId,
  children,
}: {
  id?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      data-testid={testId}
      className="scroll-mt-6 rounded-xl border border-gray-100 p-5"
    >
      {children}
    </section>
  );
}
