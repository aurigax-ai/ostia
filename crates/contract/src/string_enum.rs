pub trait StringEnum: Copy {
    const ALL: &'static [&'static str];

    fn parse(text: &str) -> Option<Self>;
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident = $text:literal,)+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant,)+
        }

        impl $crate::string_enum::StringEnum for $name {
            const ALL: &'static [&'static str] = &[$($text,)+];

            fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

pub(crate) use string_enum;
