export type Category = {
  slug: string;
  name: string;
  icon: string | undefined;
  sortOrder: number;
  /** Built-in categories can be renamed but not removed. */
  isSystem: boolean;
};

export const DEFAULT_CATEGORIES: readonly { slug: string; name: string; icon: string }[] = [
  { slug: 'ai-llm', name: 'AI & Large Language Models', icon: 'brain' },
  { slug: 'ai-image', name: 'AI Image Generation', icon: 'image' },
  { slug: 'ai-video', name: 'AI Video Generation', icon: 'film' },
  { slug: 'ai-audio', name: 'AI Voice & Audio', icon: 'mic' },
  { slug: 'social-media', name: 'Social Media', icon: 'share' },
  { slug: 'messaging', name: 'Messaging & Communication', icon: 'message' },
  { slug: 'email', name: 'Email Services', icon: 'mail' },
  { slug: 'cloud-storage', name: 'Cloud Storage', icon: 'cloud' },
  { slug: 'file-management', name: 'File Management', icon: 'folder' },
  { slug: 'productivity', name: 'Productivity Tools', icon: 'check' },
  { slug: 'office-documents', name: 'Office & Documents', icon: 'file' },
  { slug: 'website-cms', name: 'Website & CMS', icon: 'globe' },
  { slug: 'ecommerce', name: 'E-commerce', icon: 'cart' },
  { slug: 'payments', name: 'Payment Services', icon: 'card' },
  { slug: 'marketing', name: 'Marketing & Advertising', icon: 'megaphone' },
  { slug: 'analytics', name: 'Analytics & Tracking', icon: 'chart' },
  { slug: 'database', name: 'Database', icon: 'database' },
  { slug: 'automation', name: 'Automation Platforms', icon: 'bolt' },
  { slug: 'developer-tools', name: 'Developer Tools', icon: 'wrench' },
  { slug: 'coding', name: 'Coding Platforms', icon: 'code' },
  { slug: 'search', name: 'Search Engines', icon: 'search' },
  { slug: 'web-scraping', name: 'Web Scraping Services', icon: 'spider' },
  { slug: 'maps', name: 'Maps & Location Services', icon: 'map' },
  { slug: 'calendar', name: 'Calendar & Scheduling', icon: 'calendar' },
  { slug: 'crm-support', name: 'CRM & Customer Support', icon: 'users' },
  { slug: 'finance-business', name: 'Finance & Business Tools', icon: 'briefcase' },
  { slug: 'iot', name: 'IoT & Smart Devices', icon: 'cpu' },
  { slug: 'custom-api', name: 'Custom API', icon: 'plug' },
  { slug: 'webhooks', name: 'Webhooks', icon: 'webhook' },
  { slug: 'custom-apps', name: 'Custom Applications', icon: 'puzzle' },
];
