import { useCallback, useEffect, useRef, useState } from 'react';

import {
  VALID_SECTIONS,
  type SettingsSection,
} from '../settingsSections';

interface UseSettingsNavigationParams {
  initialSection?: string;
  floatingBallDevGate?: boolean;
  onSectionChange?: () => void;
}

export function useSettingsNavigation({
  initialSection,
  floatingBallDevGate,
  onSectionChange,
}: UseSettingsNavigationParams) {
  const onSectionChangeRef = useRef(onSectionChange);
  const floatingBallDisabled = floatingBallDevGate === false;

  useEffect(() => {
    onSectionChangeRef.current = onSectionChange;
  }, [onSectionChange]);

  const getInitialSection = (): SettingsSection => {
    if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
      if (initialSection === 'desktop-pet' && floatingBallDisabled) {
        return 'about';
      }
      return initialSection as SettingsSection;
    }
    return 'providers';
  };

  const [activeSection, setActiveSection] = useState<SettingsSection>(getInitialSection);
  const proxySectionRef = useRef<HTMLDivElement>(null);
  const [highlightProxySection, setHighlightProxySection] = useState(false);

  const notifySectionChange = useCallback(() => {
    onSectionChangeRef.current?.();
  }, []);

  useEffect(() => {
    if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
      const timer = window.setTimeout(() => {
        if (initialSection === 'desktop-pet' && floatingBallDisabled) {
          setActiveSection('about');
          notifySectionChange();
          return;
        }
        setActiveSection(initialSection as SettingsSection);
        notifySectionChange();
      }, 0);

      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [floatingBallDisabled, initialSection, notifySectionChange]);

  useEffect(() => {
    if (activeSection === 'desktop-pet' && floatingBallDisabled) {
      const timer = window.setTimeout(() => {
        setActiveSection('about');
      }, 0);

      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeSection, floatingBallDisabled]);

  const navigateToProxySettings = useCallback(() => {
    setActiveSection('general');
    setHighlightProxySection(true);
  }, []);

  useEffect(() => {
    if (activeSection !== 'general' || !highlightProxySection) return;

    const scrollTimer = window.setTimeout(() => {
      proxySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    const clearTimer = window.setTimeout(() => {
      setHighlightProxySection(false);
    }, 1800);

    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [activeSection, highlightProxySection]);

  return {
    activeSection,
    setActiveSection,
    proxySectionRef,
    highlightProxySection,
    navigateToProxySettings,
    notifySectionChange,
  };
}
