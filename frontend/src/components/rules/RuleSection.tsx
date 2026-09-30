import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import type { TourAnchorId } from '@/lib/tours/anchors';

interface RuleSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  /** The `tourAnchor(...)` attribute a guided tour points at. */
  anchor?: { 'data-tour-id': TourAnchorId };
}

/** One of the editor's When / If / Then panels. */
export function RuleSection({ title, description, children, anchor }: RuleSectionProps) {
  return (
    <Card as="section" aria-label={title} padding="md" {...anchor}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {description && <p className="mb-4 mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </Card>
  );
}
