import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

interface RuleSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/** One of the editor's When / If / Then panels. */
export function RuleSection({ title, description, children }: RuleSectionProps) {
  return (
    <Card as="section" aria-label={title} padding="md">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {description && <p className="mb-4 mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </Card>
  );
}
